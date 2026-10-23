# LightShop

A photo library, non-destructive RAW-style developer and layered image editor in one app. It pairs a Lightroom-style **Library** and **Develop** module with a Photoshop-style **Editor**, and runs in the browser or as a macOS desktop app.

**Current version: 2.4**. See [What's new](#whats-new).

Your photos stay on your computer: LightShop works offline and stores its catalog locally.

## Features

### Library
- Import JPEG, PNG, WebP, AVIF, GIF, BMP and camera RAW files (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2 and more) with the Import button or by dropping files on the window.
- Grid, loupe and calendar views with a histogram and EXIF metadata.
- **Events and date groups:** the grid can be grouped by event, day, month or year. An event is a run of photos taken close together; you choose how long a gap starts a new one (1 hour to 1 day). Name an event to save it as a collection.
- **Dates panel:** your photos by year, month and day, with counts. Click a date to show only that period.
- **Calendar (C):** a month view with a cover photo and count on every day you took photos, or a whole year shaded by how many photos each day has. Click a day to see its photos.
- Star ratings, pick/reject flags, color labels and keywords.
- Collections, sorted by date (under year headings) or by name, each showing the dates it covers. Plus the built-in All Photographs, Previous Import and Edited.
- Search, filtering and sorting. Pinch the grid to resize thumbnails.
- Quick Develop applies a preset to every selected photo.
- Batch export to JPEG, PNG or WebP, with quality, long-edge resize and file-name suffix options.

### Develop
- **Non-destructive editing on the GPU (WebGL2).** Edits are stored as settings and the original is never changed.
- **Basic:** white balance (with eyedropper and Auto), exposure, contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, vibrance and saturation. Auto tone sets exposure, contrast, highlights, shadows, whites and blacks in one click.
- **Tone Curve:** master and per-channel RGB curves.
- **Color Mixer:** hue, saturation and luminance for 8 color ranges. In black-and-white mode it becomes a B&W mix.
- **Color Grading:** shadow, midtone, highlight and global color wheels, with blending and balance.
- **Detail:** sharpening and noise reduction.
- **Effects:** post-crop vignette and film grain.
- **Masks:** up to 8 radial and linear gradient masks, each with its own exposure, contrast, highlights, shadows, temperature, tint, saturation and clarity.
- **Crop & straighten:** aspect presets, angle, 90° rotation and flips. **Expand in Editor** opens the photo in the Editor's Crop tool, set to grow it to a screen size of your choice.
- **Touch Up:** Heal, Clone and Red Eye. Click a blemish or paint over a larger area, and LightShop picks a matching source area. You can move or resize spots and pick a new source.
- **Presets:** 15 built-in presets, plus your own. Lightroom `.xmp` and `.lrtemplate` presets can be imported, and the current look can be exported as `.xmp`.
- **History:** a full history list, before/after view, and copy/paste of settings between photos.
- **Navigator:** shows the whole photo. When zoomed in, it outlines the visible area; click or drag it to move around.

### Editor
- Pixel, type and adjustment layers, with layer masks, opacity and 17 blend modes.
- **Tools:** Move, Marquee, Lasso, Magic Wand, Crop, Eyedropper, Spot Healing Brush, Brush, Clone Stamp, Eraser, Gradient, Paint Bucket, Type, Shape, Hand and Zoom.
- **Crop and expand:** the crop box can reach past the image to make the canvas bigger, for example to turn an iPhone wallpaper into a Mac wallpaper. **Expand to** sizes the result for a Mac display, a common desktop resolution or an iPhone. The new area can be filled with Content-Aware, Blurred Photo, Extend Edges, Mirror or a color, or left transparent. The fill goes on its own layer.
- **Drag layers between documents:** drag with the Move tool, or drag a row in the Layers panel, onto another document's tab to copy the layer or selected pixels into that document.
- **Adjustments:** 13 types, applied directly or as adjustment layers: Brightness/Contrast, Levels, Curves, Exposure, Hue/Saturation, Color Balance, Black & White, Photo Filter, Channel Mixer, Invert, Posterize, Threshold and Gradient Map.
- **Filters:**
  - Blur: Gaussian, Motion
  - Sharpen: Unsharp Mask, Sharpen, Sharpen More
  - Add Noise, Mosaic, Emboss, Find Edges, High Pass, Clouds
  - Develop Filter: the Develop adjustment panels applied to a layer, like Camera Raw Filter
- **Image:** image size, canvas size, rotation and flips.
- **Selections:** add, subtract or intersect them; feather, inverse, and load layer transparency.
- **Files:** open and save Photoshop PSD files, and export PNG, JPEG or WebP.
- **Save to Library:** stores the flattened image and keeps the layers, so you can reopen and keep editing later.

### Develop → Editor
- Click **Editor** while developing a photo (or press ⌘E) to open it in the Editor with your Develop edits. If it's already open, LightShop switches to it.
- Later Develop changes flow into the open document as an undoable **Update from Develop** step.
- If you painted on that layer in the Editor, LightShop asks first: **Update** or **Keep Editor Version**.
- If a crop in Develop changes the image size, you can open the result as a new document.

### Trackpad and mouse

| Gesture | Develop | Editor | Library |
| --- | --- | --- | --- |
| Pinch | Zoom in or out where your fingers are (Fit to 1600%) | Zoom at the pointer | Resize thumbnails |
| Two-finger scroll | Move around a zoomed photo; stops at the edges | Move around the canvas | Scroll the grid |
| Two-finger swipe sideways | Next or previous photo (in Fit) | — | — |
| ⌘-scroll or ⌥-scroll | Zoom | Zoom | Resize thumbnails (⌘) |
| Click | Fit ↔ 1:1 at that point | Uses the current tool | Select |

## Install the macOS app

Download the DMG from the [latest release](https://github.com/devdesai10/LightShop/releases/latest) (Apple Silicon Macs), or build it yourself with `npm run dist:mac` (see [Development](#development)). Then:

1. Open the DMG.
2. Drag **LightShop** to **Applications**. When updating, choose **Replace**; your catalog is kept.
3. The app is ad-hoc signed but not notarized. If macOS blocks the first launch (usually on a Mac that didn't build it), open **System Settings → Privacy & Security** and click **Open Anyway** next to LightShop.

The desktop app keeps its catalog in `~/Library/Application Support/LightShop` (**Help → Show App Data in Finder**). It is separate from any catalog in a browser. Exports go to a folder you choose, or straight to `~/Downloads`.

## Development

Requires Node.js 22 or newer (tested with 22.20) and npm.

```sh
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the Vite dev server with hot reload |
| `npm run build` | Typechecks and builds the web app into `dist/` |
| `npm run typecheck` | Runs the TypeScript compiler only |
| `npm run preview` | Serves the production build locally |
| `npm run desktop` | Builds, then opens the Electron desktop app |
| `npm run dist:mac` | Builds `LightShop.app` and `release/LightShop-<version>-arm64.dmg` (`LS_ARCH=x64 npm run dist:mac` for Intel Macs) |

The version comes from `package.json`. To release, bump it with `npm version <x.y.z> --no-git-tag-version` and run `npm run dist:mac`. The DMG file name, its disk name and the About box show the new version.

### Project structure

```
src/
  App.tsx        Top bar, module switcher, drag-and-drop import
  library/       Library module: grid, loupe, calendar, filters, metadata, collections,
                 events and date grouping (grouping.ts), Dates panel
  develop/       Develop module: WebGL2 renderer and shaders, settings and presets,
                 Touch Up (retouch.ts), masks, crop, Navigator, history
  editor/        Editor module: document model and undo history, tools, layers,
                 adjustments, filters, menus, Develop → Editor sync (session.ts),
                 crop Expand (expand.ts) and its fills (inpaint.ts, fillWorker.ts),
                 dragging layers between documents (layerDrag.ts)
  lib/           Image decoding, EXIF, RAW previews, PSD, XMP presets, color math,
                 date labels and calendar math, trackpad gestures, IndexedDB
  state/         App store: catalog, photos, collections, presets
  ui/            Shared controls, dialogs, export dialog, error boundary
electron/        Desktop shell: main process and preload bridge
scripts/         build-mac.mjs: packages the app, signs it and makes the DMG
build/, public/  App icons and web manifest
.kiro/hooks/     Kiro IDE hook that plays a chime when an agent command needs approval
```

### How it works
- **Catalog:** originals, thumbnails, Develop settings, collections, presets and saved Editor projects live in IndexedDB.
- **Develop pipeline:** Develop settings are plain data, applied on the GPU in order:
  1. Touch-up spots
  2. White balance and exposure
  3. Noise reduction, sharpening, clarity and dehaze
  4. Tone, color mixer, color grading and masks
  5. Crop and rotation, vignette and grain

  A preview of up to 2560 px is used for editing. The full-resolution image loads when you zoom in past it, and for export.
- **Editor:** a Canvas 2D compositor handles masks, blend modes and adjustment layers. Undo history has a memory budget. PSD reading and writing are implemented from Adobe's published file-format specification.
- **Content-Aware fill:** PatchMatch nearest-neighbour search with iterative patch voting, run coarse to fine on an image pyramid (after Barnes et al., 2009, and Wexler et al., 2007). A layout term favours patches from the same rows or columns as the new pixels. It runs in a Web Worker, so the app stays responsive.
- **Desktop app:** the Electron shell serves the built app from a private `app://` origin with a strict Content Security Policy. The page runs sandboxed with no Node.js access.

## What's new

### 2.4: Expand the canvas and drag layers between documents
- **Expand with the Crop tool (C):** drag the crop box past the edges of the image, or pick a size under **Expand to**, and press Enter. An iPhone wallpaper becomes a desktop one with the photo centred at full height and the sides filled in.
- **Sizes:** your current display, every Mac display (MacBook Air 13″ and 15″, MacBook Pro 14″ and 16″, iMac 24″, Studio Display, Pro Display XDR), 4K, 1440p, 1080p, 16:10 and ultrawide desktops, and current iPhones. The result is exactly that many pixels.
- **Fills for the new area:**
  - **Content-Aware** (the default) continues the scene with patches matched from the photo, taken from the same height beside it, so skies stay up and ground stays down.
  - **Blurred Photo** puts an enlarged, blurred copy of the photo behind it.
  - **Extend Edges** carries the edge colors outward, softer the further they go.
  - **Mirror** reflects the photo at its edges.
  - **Color** uses a color you pick, and **Transparent** leaves the area empty.
- **Preview before you apply:** the crop box shows a quick preview of the fill. Box edges snap to the image's edges (hold ⌘ to place them freely). The view zooms out to fit the box.
- **Fill layer:** the fill goes on its own layer above the photo, so you can hide, retouch or delete it. The whole change is one undo step, **Expand Canvas**. Slow fills show progress and can be cancelled.
- **From Develop:** the Crop & Straighten panel (R) has an **Expand** section. Choose a size and fill, then click **Expand in Editor…** to open the photo in the Editor with the box set up.
- **New crop ratios in the Editor:** Original, 16:10 and 9:16. Changing the ratio reshapes the box around its centre.
- **Drag layers between documents:** with the Move tool (V), drag onto another document's tab and hold for a moment. That document opens, and you can drop the copy exactly where you want it. Releasing on the tab itself drops it in the centre, or in the same place when both documents are the same size. With a selection, only the selected pixels are copied.
- **Drag from the Layers panel:** drag a layer's row onto another tab or another document's canvas to copy it. Dragging within the same document still reorders layers.
- Copies dragged between documents never change the original, and each drop is one undo step, **Drag Layer**. A dragged Background layer is named after the document it came from. Esc cancels a drag.

### 2.3: Events, dates and calendar
- **Group by event:** the Library grid is now split into events, photos taken close together in time, each under a header with its date, time span and photo count. Choose when a new event starts, from a 1 hour to a 1 day gap. Group by day, month or year instead, or turn grouping off.
- **Name an event:** saves the whole event as a collection, and the name then appears in the grid header. **Select** in a header selects that group's photos.
- **Dates panel:** browse by year, month and day in the left sidebar. Picking a date shows only those photos, and the chip in the filter bar clears it.
- **Calendar view (C):** every day with photos shows its best one (highest rated, then picked) and how many there are. Year mode shades each day by how many photos it has. Click a day to open it in the grid. It works with the keyboard too: arrow keys, Home/End and Page Up/Down.
- **Collections are date-aware:** they're sorted by date under year headings (or by name), each shows the dates it covers, and a new collection is named after its photos' dates.
- Up and down arrows in a grouped grid move straight across group boundaries.
- The filter bar fits narrower windows: the view switcher sits at the top left, and the arrange controls move to a second row when needed.
- Grouping, event gap, collection order and calendar mode are remembered.

### 2.2: Better Auto Tone and Auto White Balance
- **Auto Tone judges exposure by the scene:** it takes into account whether a scene is mostly dark or mostly bright, instead of pushing every photo to the same average. Badly under- or overexposed photos are corrected fully, while photos that are nearly right only get a nudge.
- **Full tonal range without clipping:** contrast, highlights, shadows, whites and blacks are fitted together through Develop's own tone curve. The brightest detail lands just below white and the darkest just above black, with no new blown highlights.
- **Faded and hazy photos** get their blacks and contrast back instead of just being darkened.
- **Consistent:** the same photo shot a stop or two darker comes out nearly the same after Auto.
- **Auto White Balance** combines four independent estimates of the light's color and uses their median, so foliage, sand or water is less likely to fool it. Blue casts are corrected almost fully, warm light keeps a little of its warmth, and photos that are already neutral are left alone.
- Both Auto buttons only look at the part of the photo inside the crop, and analyze a larger, properly downsampled preview.

### 2.1: Trackpad navigation
- **Pinch to zoom in Develop:** zooms in on the spot under your fingers, from Fit up to 1600%. Pinching out returns to Fit.
- **Two-finger scroll in Develop:** moves around a zoomed photo and stops at the edges.
- **Swipe between photos:** a sideways two-finger swipe in Fit goes to the next or previous photo.
- **Zoom readout:** shown next to Fit / 1:1. New shortcuts ⌘+, ⌘−, ⌘0 and ⌘1; ⌘-scroll or ⌥-scroll zooms with a mouse.
- **Navigator:** outlines the visible area when zoomed; click or drag it to jump around the photo.
- **Sharper zooming:** the full-resolution image loads automatically once you zoom past the preview. Zoomed-out views no longer shimmer.
- **Editor:** pinch and scroll share the new gesture handling, and a fast swipe can no longer fling the canvas out of view.
- **Library:** pinch the grid to resize thumbnails.
- **Browser version:** pinching never zooms the whole page.

### 2.0: Touch Up and Develop → Editor
- **New Touch Up tool in Develop (Q):**
  - **Heal:** blends texture from a matching area.
  - **Clone:** copies a matching area exactly.
  - **Red Eye:** only changes strongly red pixels, so irises and skin are left alone.
  - Click a blemish or paint over a larger area. Drag a spot's source circle, resize it, or press `/` for a new source.
  - Spots are saved with the photo and appear in exports, thumbnails and the Editor. Presets and pasted settings leave them alone.
- **Develop → Editor sync:** the photo you're developing opens in the Editor with its edits. Later Develop changes update it as an undoable step, and you're asked before Editor edits would be replaced.
- **Fixed:** opening Develop with an empty catalog turned the whole window black. Each module now shows an error message with **Try Again** instead of going blank.
- Confirmation dialogs now wait in line instead of replacing each other.
- The DMG, its disk name and the About box show the version.

### 0.1.0: First release
- Library, Develop and Editor modules, and the macOS desktop app and DMG.
- macOS-style interface: dark graphite theme, translucent panels, a segmented module switcher in the title bar, and macOS-style menus, sheets and notifications.
- In-app dialogs replace the browser's `prompt` and `confirm`, which Electron doesn't support.

## Limitations
- Camera RAW files are shown through their embedded JPEG preview. There is no full RAW decoding (demosaicing).
- HEIC/HEIF photos (the iPhone default) can't be opened yet, because Chromium, and so the desktop app, can't decode them. Export them as JPEG first.
- The Editor works in 8 bits per channel.
- PSD support covers 8-bit RGB and grayscale with pixel layers. Type and adjustment layers are saved as pixels.
- Editor documents stay in memory until you choose **Save to Library**. LightShop warns before you quit with unsaved documents.
- Pinch zoom in Safari is handled but untested. The desktop app and Chromium browsers (Chrome, Brave, Edge) are tested.
- Events are worked out from capture times only, not locations. Photos without an EXIF date use the file's modified time. Named events are stored as collections.
- Content-Aware fills take a few seconds for a laptop-sized wallpaper and up to about 15 seconds at Pro Display XDR size (6016 × 3384) on an M1. Results above 24 megapixels are filled at a lower resolution and enlarged, and the Crop tool's largest result is 64 megapixels.
- Content-Aware works best on landscapes, skies and textures. It copies patches of the photo rather than inventing new content, so faces, text and other distinct objects at the edges can come out repeated or distorted. Blurred Photo is the safer choice for those.

---

LightShop is an independent project and is not affiliated with or endorsed by Adobe. Lightroom and Photoshop are trademarks of Adobe Inc.
