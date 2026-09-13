# `src/theme/` — the background photograph

## Paste the file here

```
src/theme/app-bg.webp        ← this folder, this name
```

`.png`, `.jpg`, `.jpeg` and `.avif` work too — the extension is read from
whatever is actually in the folder, so you do not have to convert anything.

That is the whole procedure. Nothing else needs editing: `background.js` finds
it, `AppBackdrop.jsx` renders it, and the app shell and the login screen both
render `AppBackdrop`. One paste reaches every screen in the project.

To remove the background everywhere, delete the file.

---

## What makes a good file here

| | |
|---|---|
| Width | **1920px** is plenty. It is a background, not a print. |
| Weight | keep it under **~300 KB**. Every visitor downloads it before they can sign in, some of them on hotel wifi. |
| Format | **WebP** if you have the choice — roughly half a JPEG at the same quality. |
| Orientation | landscape, and it has to survive `cover` cropping on a tall phone. |

If the file you have is heavier than that, it can be converted in place with the
`sharp` package the project already depends on:

```bash
node -e "require('sharp')('big.jpg').resize({width:1920}).webp({quality:78}).toFile('src/theme/app-bg.webp')"
```

### Two things worth checking before you settle on one

**The middle gets covered.** On login it is the sign-in card; in the app it is
the rail down the left and cards across the rest. A photograph whose subject
sits dead centre will be mostly hidden — one with its interest toward the
**edges and corners** survives the layout. This is why an entrance shot with the
car at one side and depth at the other works well, and a centred hero car does
not.

**Do not use an image with a dark band down its left edge.** This has bitten the
project once already. A band roughly the width of a sidebar lands next to the
real 240px rail and reads as a seam between two sidebars. `background-position`
does not save you: `cover` crops only on the axis that overflows, so on a window
proportionally wider than the image there is no horizontal crop at all and the
band sits at x=0 whatever the position is set to. Crop it out of the file.

---

## How strong the veil is

The photograph sits under a veil painted in the page's own surface colour, so it
follows light and dark rather than glowing at night. Its strength is a gradient
— nearly solid at the bottom-left where the content sits, opening up toward the
top-right where the photograph can be seen.

Both ends are tokens in `src/index.css`:

```css
--veil-near: 0.97;   /* bottom-left, behind the content */
--veil-far:  0.35;   /* top-right, where the photo shows */
```

Raise them to calm the page down, lower them to let more photograph through. The
two screens to check after changing them are **Records** and the **bookings
calendar** — those are the two whose content reaches furthest into the corners.

## Why a photograph works behind a working screen at all

Because the app is built out of cards, and a card is opaque. `bg-surface` is a
solid colour in both themes, so every number, name and token sits on its own
flat ground whatever is behind the page; the photograph shows in the gutters,
the margins and the space below short content. The card layout is what buys
this — the veil alone would not.

It is hidden when printing. The Records screen goes on paper, and a full-bleed
photograph there costs a cartridge and makes the table harder to read.
