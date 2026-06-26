# Required attribution

`crossbeam-cli` is licensed under the [BSD 4-Clause License](./LICENSE). Clause 3 (the "advertising clause") requires that any advertising material mentioning features or use of this software display the following acknowledgement:

> **"This product includes software developed by Ryan Hughes (Fan Pier Labs, https://fanpierlabs.com)."**

"Advertising materials" is generally understood to include:

- Product webpages, marketing landing pages, email campaigns
- App store listings, product descriptions, README files of products built on this software
- Press releases, launch posts, conference slides, sales decks
- Customer-facing About / Credits / Acknowledgements screens
- Any material that names this software as part of a product or service

If you'd like to use `crossbeam-cli` without the advertising-clause requirement, a commercial license is available — contact ryan@fanpierlabs.com.

## Drop-in snippets

Use whichever fits your medium. The text inside the quotes must appear verbatim.

### Plain text / About page

```
This product includes software developed by Ryan Hughes
(Fan Pier Labs, https://fanpierlabs.com).
```

### Markdown

```md
This product includes software developed by [Ryan Hughes](https://fanpierlabs.com)
(Fan Pier Labs).
```

### HTML

```html
<p>
  This product includes software developed by
  <a href="https://fanpierlabs.com">Ryan Hughes</a> (Fan Pier Labs).
</p>
```

### iOS / Android open-source attribution screens

Most attribution-screen tooling (CocoaPods-Acknowledgements, license-checker, oss-attribution-generator, etc.) auto-collects the `LICENSE` and `NOTICE` files shipped with this package. Verify your build pipeline picks up `node_modules/crossbeam-cli/NOTICE`.

## Why BSD-4-Clause?

We chose this license because we want users of `crossbeam-cli` to credit the engineering work that went into it visibly, in places real humans see. The advertising clause is unusual today, but it's well-understood, SPDX-recognized, and historically the standard tool for exactly this purpose. If the requirement is a blocker for your use case, please reach out about a commercial license.
