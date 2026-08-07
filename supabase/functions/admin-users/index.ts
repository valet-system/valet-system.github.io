// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ ⚠️  NOT IN USE. KEPT AS A FALLBACK.                                  │
 * │                                                                     │
 * │ The app does NOT call this. Staff management runs through Postgres    │
 * │ RPC instead — see supabase/migrations/20260731090400_                │
 * │ staff_management_rpc.sql and src/lib/adminApi.js.                    │
 * │                                                                     │
 * │ WHY WE SWITCHED AWAY FROM IT                                          │
 * │   Deploying an Edge Function needs the Supabase CLI authenticated to  │
 * │   the account that owns the project. On a machine with several        │
 * │   Supabase accounts that is a real obstacle, and it blocks adding a   │
 * │   valet — an everyday operation — behind a developer toolchain.       │
 * │   The Postgres version needs nothing but a migration.                │
 * │                                                                     │
 * │   It is also atomic. This function has to delete the auth user by     │
 * │   hand if the role insert fails, because GoTrue and Postgres share    │
 * │   no transaction. Inside Postgres that failure mode cannot occur.     │
 * │                                                                     │
 * │ WHEN TO COME BACK TO THIS FILE                                        │
 * │   The RPC version writes to auth.users and auth.identities directly.  │
 * │   If a future GoTrue release changes that schema and creating users   │
 * │   starts failing, deploy this instead:                               │
 * │     supabase functions deploy admin-users --profile <yours>          │
 * │   then point src/lib/adminApi.js back at functions.invoke().          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/admin-users/index.ts                       │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The only way staff accounts are created or changed. Five actions,  │
 * │   all POSTed to this one endpoint as { action, ... }:                 │
 * │                                                                     │
 * │     create      name + phone + pin (+ role, property for sysadmin)   │
 * │     reset_pin   give someone a new PIN (a PIN cannot be recovered)   │
 * │     set_active  deactivate / reactivate                              │
 * │     rename      change display name                                  │
 * │     change_phone change the login number                             │
 * │                                                                     │
 * │ WHY AN EDGE FUNCTION AND NOT JUST A DB INSERT                          │
 * │   Creating a staff member means TWO writes that must both succeed:    │
 * │     1. an auth.users row  — holds the bcrypt-hashed PIN              │
 * │     2. a user_roles row   — holds name, role, property               │
 * │   Only the service_role key can do (1), and that key must never       │
 * │   reach a browser: it bypasses RLS entirely, so anyone holding it can │
 * │   read and rewrite all four properties' data. So the write happens    │
 * │   here, on the server, and the browser only ever sends a form.        │
 * │                                                                     │
 * │ THE ROLLBACK THAT MATTERS                                             │
 * │   These are two separate systems — GoTrue and Postgres — so there is  │
 * │   no transaction spanning them. If step 2 fails after step 1          │
 * │   succeeded, an orphan auth account exists with no role: that person  │
 * │   can log in and sees "Account not ready" forever, AND their number   │
 * │   is now taken, so retrying fails with "already exists". Unpickable   │
 * │   without dashboard access.                                          │
 * │                                                                     │
 * │   So step 2's failure path DELETES the auth user it just created.     │
 * │   See createUser() below.                                            │
 * │                                                                     │
 * │ AUTHORISATION                                                        │
 * │   Every request goes through identifyCaller() and then either         │
 * │   resolveTargetScope() (new users) or canActOn() (existing users).    │
 * │   A valet_admin's claimed role and property are DISCARDED, not        │
 * │   validated — see _shared/caller.ts for why that distinction is the   │
 * │   difference between safe and trivially escalatable.                  │
 * │                                                                     │
 * │ DEPLOY                                                               │
 * │   supabase functions deploy admin-users                              │
 * │   Requires secrets: SUPABASE_SERVICE_ROLE_KEY (set automatically by   │
 * │   Supabase), and optionally PHONE_EMAIL_DOMAIN if you changed it.     │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   _shared/http.ts, _shared/caller.ts                                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { fail, handlePreflight, json } from '../_shared/http.ts'
import {
  canActOn,
  derivePhoneEmail,
  identifyCaller,
  PHONE_REGEX,
  resolveTargetScope,
  toE164,
  validatePin,
  type Caller,
} from '../_shared/caller.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4'

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  if (req.method !== 'POST') {
    return fail('METHOD', 'Use POST.', 405)
  }

  // ── who is asking? ───────────────────────────────────────────────────
  const identity = await identifyCaller(req)
  if (!identity.ok) return fail(identity.code, identity.error, identity.status)

  const { caller, admin } = identity

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail('BAD_JSON', 'Malformed request.')
  }

  const action = String(body.action || '')

  try {
    switch (action) {
      case 'create':
        return await createUser(admin, caller, body)
      case 'reset_pin':
        return await resetPin(admin, caller, body)
      case 'set_active':
        return await setActive(admin, caller, body)
      case 'rename':
        return await rename(admin, caller, body)
      case 'change_phone':
        return await changePhone(admin, caller, body)
      default:
        return fail('BAD_ACTION', `Unknown action "${action}".`)
    }
  } catch (error) {
    // Any unexpected throw. Logged in full for whoever debugs it; the admin
    // sees a plain sentence rather than a stack trace.
    console.error('[admin-users] unhandled error:', error)
    return fail('INTERNAL', 'Something went wrong. Please try again.', 500)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════

async function createUser(admin: SupabaseClient, caller: Caller, body: Record<string, unknown>) {
  const name = String(body.name || '').trim()
  const phone = String(body.phone || '').replace(/\D/g, '')
  const pin = String(body.pin || '')

  // ── validate the parts the caller is allowed to choose ──────────────
  if (name.length < 2) return fail('BAD_NAME', "Enter the person's name.")
  if (name.length > 80) return fail('BAD_NAME', 'Name is too long.')
  if (!PHONE_REGEX.test(phone)) {
    return fail('BAD_PHONE', 'Enter a valid 10-digit mobile number starting 6-9.')
  }

  const pinCheck = validatePin(pin)
  if (!pinCheck.ok) return fail('BAD_PIN', pinCheck.error)

  // ── decide role + property SERVER-SIDE ──────────────────────────────
  // For a valet_admin these come out as 'operator' + their own property no
  // matter what the request asked for.
  const scope = resolveTargetScope(caller, {
    role: body.role as string | undefined,
    propertyId: (body.property_id as string | null | undefined) ?? null,
  })
  if (!scope.ok) return fail(scope.code, scope.error, 403)

  const authEmail = derivePhoneEmail(phone)
  if (!authEmail) return fail('BAD_PHONE', 'Enter a valid 10-digit mobile number.')

  // ── is the number already in use? ───────────────────────────────────
  // Checked up front so the admin gets "already registered" instead of a raw
  // unique-constraint error, and so we do not create an auth user we then have
  // to roll back.
  const { data: existing } = await admin
    .from('user_roles')
    .select('id, name, property_id')
    .eq('phone', phone)
    .maybeSingle()

  if (existing) {
    return fail(
      'PHONE_TAKEN',
      `That number is already registered to ${existing.name}.`,
      409,
    )
  }

  // ── STEP 1: the auth account (holds the hashed PIN) ─────────────────
  //
  // email_confirm: true is REQUIRED. The derived address can never receive
  // mail, so without it the account stays unconfirmed and every login fails
  // with "Email not confirmed".
  //
  // `phone` is set too, purely so the real number shows in the Supabase
  // dashboard's Users list. It is never used to log in — phone login is
  // disabled on this project. If GoTrue rejects it (some configurations refuse
  // a phone while the phone provider is off) we retry without it, because a
  // nicer-looking dashboard is not worth failing a hire over.
  let authUserId: string | null = null

  const createPayload = {
    email: authEmail,
    password: pin,
    email_confirm: true,
    user_metadata: { name, created_by: caller.roleRowId },
  }

  let created = await admin.auth.admin.createUser({
    ...createPayload,
    phone: toE164(phone),
    phone_confirm: true,
  })

  if (created.error) {
    const message = created.error.message || ''

    // Retry without the cosmetic phone field.
    if (/phone/i.test(message)) {
      console.warn('[admin-users] phone field rejected, retrying without it:', message)
      created = await admin.auth.admin.createUser(createPayload)
    }
  }

  if (created.error || !created.data?.user) {
    const message = created.error?.message || 'unknown error'
    console.error('[admin-users] createUser failed:', message)

    if (/already|registered|exists/i.test(message)) {
      return fail(
        'AUTH_EXISTS',
        'An account already exists for that number but has no role. Ask a system admin to clean it up.',
        409,
      )
    }
    // Fires when the dashboard's password policy was tightened past a 6-digit
    // PIN. Naming the exact setting saves an hour of guessing.
    if (/password/i.test(message)) {
      return fail(
        'PIN_REJECTED',
        'Supabase rejected the 6-digit PIN. Check Authentication → Policies: minimum length must be 6 with no required characters.',
      )
    }
    return fail('AUTH_FAILED', 'Could not create the login account.', 500)
  }

  authUserId = created.data.user.id

  // ── STEP 2: the role row ────────────────────────────────────────────
  const { data: roleRow, error: roleError } = await admin
    .from('user_roles')
    .insert({
      user_id: authUserId,
      property_id: scope.propertyId,
      role: scope.role,
      name,
      phone,
      is_active: true,
    })
    .select('id, name, phone, role, property_id, is_active, created_at')
    .single()

  if (roleError) {
    // ── ROLLBACK ──
    // Without this, an orphan auth account survives: that person can log in,
    // sees "Account not ready" forever, and their number is now taken so
    // retrying fails. Unfixable from inside the app.
    console.error('[admin-users] role insert failed, rolling back auth user:', roleError)
    const { error: deleteError } = await admin.auth.admin.deleteUser(authUserId)
    if (deleteError) {
      // Now it really is stuck. Log loudly with the id so it can be removed by
      // hand, and tell the admin the truth rather than "try again".
      console.error('[admin-users] ROLLBACK FAILED — orphan auth user:', authUserId, deleteError)
      return fail(
        'ORPHAN',
        `Partly created. Ask a developer to remove auth user ${authUserId}.`,
        500,
      )
    }

    if (/duplicate key/i.test(roleError.message)) {
      return fail('PHONE_TAKEN', 'That number is already registered.', 409)
    }
    if (/property_scope/i.test(roleError.message)) {
      return fail('BAD_SCOPE', 'A system admin cannot have a property; everyone else must.', 400)
    }
    return fail('ROLE_FAILED', 'Could not save the user record.', 500)
  }

  console.log(
    `[admin-users] created ${scope.role} ${name} (${phone}) by ${caller.role} ${caller.name}`,
  )

  // The PIN is returned ONCE, so the admin screen can display it to read out
  // to the new operator. It is not stored anywhere in readable form — this
  // response is the only chance to see it, which is why the UI shows it in a
  // panel the admin must dismiss.
  return json({ ok: true, user: roleRow, pin })
}

// ═══════════════════════════════════════════════════════════════════════
// RESET PIN
//
// The answer to "operator forgot their PIN". A PIN cannot be read back —
// Supabase stores only a bcrypt hash — so it is replaced, not recovered.
// ═══════════════════════════════════════════════════════════════════════

async function resetPin(admin: SupabaseClient, caller: Caller, body: Record<string, unknown>) {
  const targetId = String(body.user_role_id || '')
  const pin = String(body.pin || '')

  if (!targetId) return fail('BAD_TARGET', 'Which user?')

  const pinCheck = validatePin(pin)
  if (!pinCheck.ok) return fail('BAD_PIN', pinCheck.error)

  const target = await loadTarget(admin, targetId)
  if (!target.ok) return fail(target.code, target.error, target.status)

  const permitted = canActOn(caller, target.row)
  if (!permitted.ok) return fail(permitted.code, permitted.error, 403)

  // Guard against an admin resetting their OWN PIN here. It would work, but it
  // is the wrong door: Change PIN verifies the current PIN first, this does
  // not. Someone on an unattended admin laptop could otherwise lock the real
  // admin out of their own account.
  if (target.row.id === caller.roleRowId) {
    return fail('USE_CHANGE_PIN', 'Use Change PIN to change your own PIN.', 400)
  }

  const { error } = await admin.auth.admin.updateUserById(target.row.user_id, { password: pin })

  if (error) {
    console.error('[admin-users] resetPin failed:', error)
    if (/password/i.test(error.message || '')) {
      return fail(
        'PIN_REJECTED',
        'Supabase rejected the 6-digit PIN. Check Authentication → Policies: minimum length must be 6 with no required characters.',
      )
    }
    return fail('RESET_FAILED', 'Could not reset the PIN.', 500)
  }

  console.log(`[admin-users] PIN reset for ${target.row.name} by ${caller.role} ${caller.name}`)

  return json({ ok: true, pin })
}

// ═══════════════════════════════════════════════════════════════════════
// SET ACTIVE
//
// Deactivate rather than delete. is_active = false makes my_role() return NULL
// for that person, so every RLS policy denies them and they cannot sign in —
// while every task and car they ever handled stays intact and attributable.
// Deleting the row would orphan months of valet_tasks.
// ═══════════════════════════════════════════════════════════════════════

async function setActive(admin: SupabaseClient, caller: Caller, body: Record<string, unknown>) {
  const targetId = String(body.user_role_id || '')
  const isActive = Boolean(body.is_active)

  if (!targetId) return fail('BAD_TARGET', 'Which user?')

  const target = await loadTarget(admin, targetId)
  if (!target.ok) return fail(target.code, target.error, target.status)

  const permitted = canActOn(caller, target.row)
  if (!permitted.ok) return fail(permitted.code, permitted.error, 403)

  // Locking yourself out is not a recoverable mistake from inside the app.
  if (target.row.id === caller.roleRowId) {
    return fail('SELF', 'You cannot deactivate your own account.', 400)
  }

  // An operator mid-task would vanish from the assignment list while still
  // holding someone's car keys. Make the admin resolve the task first.
  if (!isActive) {
    const { count } = await admin
      .from('valet_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_operator_id', target.row.id)
      .in('status', ['assigned', 'in_progress', 'at_pickup', 're_parking'])

    if ((count ?? 0) > 0) {
      return fail(
        'HAS_ACTIVE_TASKS',
        `${target.row.name} has ${count} task${count === 1 ? '' : 's'} in progress. Finish or reassign them first.`,
        409,
      )
    }
  }

  const { data, error } = await admin
    .from('user_roles')
    .update({ is_active: isActive })
    .eq('id', targetId)
    .select('id, name, phone, role, property_id, is_active')
    .single()

  if (error) {
    console.error('[admin-users] setActive failed:', error)
    return fail('UPDATE_FAILED', 'Could not update the user.', 500)
  }

  return json({ ok: true, user: data })
}

// ═══════════════════════════════════════════════════════════════════════
// RENAME
// ═══════════════════════════════════════════════════════════════════════

async function rename(admin: SupabaseClient, caller: Caller, body: Record<string, unknown>) {
  const targetId = String(body.user_role_id || '')
  const name = String(body.name || '').trim()

  if (!targetId) return fail('BAD_TARGET', 'Which user?')
  if (name.length < 2) return fail('BAD_NAME', 'Enter a name.')
  if (name.length > 80) return fail('BAD_NAME', 'Name is too long.')

  const target = await loadTarget(admin, targetId)
  if (!target.ok) return fail(target.code, target.error, target.status)

  const permitted = canActOn(caller, target.row)
  if (!permitted.ok) return fail(permitted.code, permitted.error, 403)

  const { data, error } = await admin
    .from('user_roles')
    .update({ name })
    .eq('id', targetId)
    .select('id, name, phone, role, property_id, is_active')
    .single()

  if (error) {
    console.error('[admin-users] rename failed:', error)
    return fail('UPDATE_FAILED', 'Could not rename the user.', 500)
  }

  return json({ ok: true, user: data })
}

// ═══════════════════════════════════════════════════════════════════════
// CHANGE PHONE
//
// The number IS the login, so this is not an ordinary field edit: it changes
// how someone signs in. Both records have to move together —
// user_roles.phone AND the derived auth email. Update one and that person can
// never log in again, with no error explaining why.
// ═══════════════════════════════════════════════════════════════════════

async function changePhone(admin: SupabaseClient, caller: Caller, body: Record<string, unknown>) {
  const targetId = String(body.user_role_id || '')
  const phone = String(body.phone || '').replace(/\D/g, '')

  if (!targetId) return fail('BAD_TARGET', 'Which user?')
  if (!PHONE_REGEX.test(phone)) {
    return fail('BAD_PHONE', 'Enter a valid 10-digit mobile number starting 6-9.')
  }

  const target = await loadTarget(admin, targetId)
  if (!target.ok) return fail(target.code, target.error, target.status)

  const permitted = canActOn(caller, target.row)
  if (!permitted.ok) return fail(permitted.code, permitted.error, 403)

  if (phone === target.row.phone) {
    return json({ ok: true, user: target.row, unchanged: true })
  }

  const { data: clash } = await admin
    .from('user_roles')
    .select('name')
    .eq('phone', phone)
    .maybeSingle()

  if (clash) {
    return fail('PHONE_TAKEN', `That number is already registered to ${clash.name}.`, 409)
  }

  const newEmail = derivePhoneEmail(phone)
  if (!newEmail) return fail('BAD_PHONE', 'Enter a valid 10-digit mobile number.')

  // Auth first. If it fails, nothing has changed and the user can still log in
  // with their old number — a safe failure. Doing user_roles first would leave
  // the two out of step on an auth error, locking them out.
  const { error: authError } = await admin.auth.admin.updateUserById(target.row.user_id, {
    email: newEmail,
    email_confirm: true,
    phone: toE164(phone),
    phone_confirm: true,
  })

  if (authError) {
    console.error('[admin-users] changePhone auth update failed:', authError)
    return fail('AUTH_FAILED', 'Could not change the login number.', 500)
  }

  const { data, error } = await admin
    .from('user_roles')
    .update({ phone })
    .eq('id', targetId)
    .select('id, name, phone, role, property_id, is_active')
    .single()

  if (error) {
    // Auth moved but our table did not. The two now disagree, and the person
    // can log in with the NEW number while every screen shows the old one.
    // Put auth back.
    console.error('[admin-users] changePhone role update failed, reverting auth:', error)
    const oldEmail = derivePhoneEmail(target.row.phone)
    if (oldEmail) {
      await admin.auth.admin.updateUserById(target.row.user_id, {
        email: oldEmail,
        email_confirm: true,
        phone: toE164(target.row.phone),
        phone_confirm: true,
      })
    }
    return fail('UPDATE_FAILED', 'Could not change the number. Nothing was changed.', 500)
  }

  console.log(
    `[admin-users] phone changed ${target.row.phone} -> ${phone} by ${caller.role} ${caller.name}`,
  )

  return json({ ok: true, user: data })
}

// ═══════════════════════════════════════════════════════════════════════
// SHARED
// ═══════════════════════════════════════════════════════════════════════

interface TargetRow {
  id: string
  user_id: string
  name: string
  phone: string
  role: string
  property_id: string | null
  is_active: boolean
}

async function loadTarget(
  admin: SupabaseClient,
  id: string,
): Promise<{ ok: true; row: TargetRow } | { ok: false; code: string; error: string; status: number }> {
  const { data, error } = await admin
    .from('user_roles')
    .select('id, user_id, name, phone, role, property_id, is_active')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    console.error('[admin-users] loadTarget failed:', error)
    return { ok: false, code: 'LOOKUP_FAILED', error: 'Could not find that user.', status: 500 }
  }
  if (!data) {
    return { ok: false, code: 'NOT_FOUND', error: 'That user no longer exists.', status: 404 }
  }

  return { ok: true, row: data as TargetRow }
}
