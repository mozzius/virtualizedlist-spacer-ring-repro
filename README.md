# VirtualizedList spacer ring under `maintainVisibleContentPosition`

After a large prepend to a `FlatList` with `maintainVisibleContentPosition`
(mVCP), the list and the mVCP anchor can fall into a cycle that never settles.
Every ~67 ms `contentSize.height` and `contentOffset.y` jump together by
~426 pt, then jump back. The rows on screen don't move, because mVCP
compensates exactly. But `onScroll` fires ~15 times a second with ±426 pt
"movements", the scroll indicator jitters, and the list keeps re-rendering at
rest for as long as you leave it.

The cause is in `@react-native/virtualized-lists`. After the prepend, the
interior spacer between the retained scroll-to-top cells and the render window
is sized from a measured frame at one end and `_averageCellLength * index` at
the other. Its size changes whenever a cell mounts or unmounts at the window's
leading edge, and mVCP has to chase it. [`ISSUE.md`](ISSUE.md) has the full
analysis and a proposed fix.

- **Upstream issue:** not filed yet
- **Found in:** the Bluesky app
  ([bluesky-social/social-app#11872](https://github.com/bluesky-social/social-app/pull/11872)
  carries the fix as a patch)

## Environment

| | |
| --- | --- |
| react-native | 0.87.1 (also 0.86.3; the code is unchanged on `main` at 4d590e6) |
| react | 19.2.3 |
| Architecture | New (Fabric), Hermes |
| Reproduced on | iOS Simulator, iPhone 17 Pro, iOS 26.5 |
| Also reproduced on | Android Emulator, Pixel 9 Pro, API 35 |
| Dependencies | Only the template's, plus `patch-package` (see below) |

## Running it

```bash
cd ReproducerApp
yarn install            # postinstall applies patches/ with patch-package
(cd ios && bundle install && bundle exec pod install)
yarn start
yarn ios                # or: yarn android
```

1. Tap **Run**. The app scrolls 3000 pt down, prepends 50 rows at the top,
   and once the prepend has landed scrolls 450 pt back up into the new rows.
2. Don't touch anything, and watch the readout at the top.

| | Stock | Fix on |
| --- | --- | --- |
| `reversals in last 1s` | ~15, indefinitely | 0 |
| `ring` counter | climbs ~14/s until you reset | 0-1 |
| `corrections` after Run | hundreds, still climbing | 2-4, then none |
| Visible rows | still | still |

Drag the list slowly while it's ringing to see the scroll indicator jitter
under your finger. You can also scroll up through the prepended rows by hand:
stock rings in bursts every time the window's leading edge passes a row.

### The readout and logs

`onScroll` (`scrollEventThrottle={16}`) logs every event to the JS console
(open React Native DevTools with `j` in Metro) with the prefix `[ring]`:

```text
[ring] +3917ms y=20191.0 (dy=+426.3) h=28605.0 (dh=+426.3) correction #7 RING #4 (69ms after -426.3)
[ring] +3982ms y=19764.7 (dy=-426.3) h=28178.7 (dh=-426.3) correction #8 RING #5 (65ms after +426.3)
```

- **correction:** an event whose offset moved by the same amount as the
  content height (`|dh| >= 20` and `|dy - dh| <= 2`). That is mVCP holding the
  anchor, not the user scrolling.
- **ring:** a correction that undid the previous one (opposite sign) within
  300 ms.
- **reversals in last 1s:** how many times `dy` changed sign in the last
  second.

The rows have deterministic heights from 60 to 600 pt, from a hash of the row
id, so every run lays out identically. Each row shows its id and height.

## Toggling the fix

The **Fix** switch passes `measureInteriorSpacers={true}` to the `FlatList`.
Toggling it also resets the list. That prop doesn't exist upstream. It comes
from [`patches/@react-native+virtualized-lists+0.87.1.patch`](ReproducerApp/patches/@react-native+virtualized-lists+0.87.1.patch),
which `patch-package` applies on `yarn install`.

- **Switch off:** `VirtualizedList` runs the stock code path, unchanged. The new
  method returns `null` before reading anything, and the spacer uses the
  upstream expression.
- **Switch on:** a spacer that has laid-out cells on both sides is sized from
  those two frames (`below.offset - (above.offset + above.length)`), not from
  the average. The prop exists only so that stock and fixed can be compared in
  the same app. The fix proposed in `ISSUE.md` is unconditional.

`App.tsx` is the whole repro. FlatList's TypeScript types don't know the prop,
hence the one `@ts-expect-error`.

## Evidence

Recorded on the iOS simulator with this app. Logs are from the JS console.

| File | What |
| --- | --- |
| [`evidence/ios-stock.mp4`](evidence/ios-stock.mp4) | Stock: one tap on Run, then hands off |
| [`evidence/ios-fixed.mp4`](evidence/ios-fixed.mp4) | Fix on, same steps |
| [`evidence/ios-stock-drag.mp4`](evidence/ios-stock-drag.mp4) | Stock: a slow drag held while it rings, so the scroll indicator jitters |
| [`evidence/ios-stock.log`](evidence/ios-stock.log), [`ios-fixed.log`](evidence/ios-fixed.log) | Logs of the two runs in the videos |
| [`evidence/ios-scroll-up.log`](evidence/ios-scroll-up.log) | Scrolling up through the prepended rows: 423 corrections and 285 ring steps stock, against 6 and 0 fixed |
| [`evidence/ios-spacer-diagnostics.log`](evidence/ios-spacer-diagnostics.log) | Temporary instrumentation of the spacer sizing, showing the two states the stock list alternates between |
| [`evidence/android.log`](evidence/android.log) | The same on the Android emulator |

Across repeated runs on iOS, stock rang until reset 6 times out of 6. With the
fix, the list settled after 2-4 corrections 5 times out of 5.
