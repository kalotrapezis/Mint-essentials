# Changelog

All notable changes to the **grun** applet are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/), and the project aims to
follow [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-06-25

First public release on GitHub (as part of
[Mint-essentials](https://github.com/kalotrapezis/Mint-essentials)).

### Added
- Home dashboard: a start-menu grid of clipboard history, most-used apps and
  recent files, with inline per-item actions and expand/collapse sections.
- Clipboard manager with pinnable text/image clips.
- In-popup settings page (⚙): function priority, web/AI engine order and the
  home dashboard toggles.
- This screenshot and documentation.

### Changed
- **Fixed-box popup sizing.** The popup now keeps one stable size for both the
  home dashboard and search results instead of resizing to fit its content.
  Previously the box shrank and grew as you typed (home was wide, then each
  query resized it). Width and height are now pinned and the result list scrolls
  inside — the same approach the Cinnamon menu uses.
- Background now covers the full width of the card grid (the previous width
  calculation didn't account for each card's padding and border, leaving an
  uncovered strip on the right).
- Tuned the default popup height.

## [0.1.0]

- Internal pre-release: launcher core ported from the standalone grun — apps,
  calculator, web/AI search, files, system power, layout-independent and
  typo-tolerant matching, drawn as a flicker-free Cinnamon popup.
