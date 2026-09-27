# Visual tools

This local Pi extension registers `write_svg`, `edit_svg`, `render_svg`,
`write_mermaid`, `edit_mermaid`, and `render_mermaid`. Source files are staged
under the OS temporary directory; published PNGs go to `cwd/viz` with unique
names. Rendering returns an inline PNG for the maker to inspect before
publishing.

SVG rendering uses installed `resvg`, `rsvg-convert`, or `magick` (in that
order). Mermaid rendering requires an installed `mmdc` and browser. Missing
renderers produce an actionable error; this extension never downloads them.

Enable this extension alongside the local subagents extension, then reload Pi.
The maker roles in `subagents/` request these tools and the existing loader
passes the active tool source extension to child processes.

For example, the primary agent can use
`delegate({agent: "svg-maker", mode: "sync", task: "..."})`; each maker
finishes through the injected `finish_task` tool after inspecting its PNG.

Adapted from `amosblomqvist/learn`, commit
`7cfd8942f82ab9476e63572387e1fe9bcea5082c`
([upstream source](https://github.com/amosblomqvist/learn/tree/7cfd8942f82ab9476e63572387e1fe9bcea5082c/extensions/visual-tools)).
The upstream repository does not include a license file in that revision; review
the source before redistribution.
