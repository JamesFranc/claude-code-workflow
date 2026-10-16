# Third-Party Notices

This project is licensed under the GNU General Public License, version 3 or later (see `LICENSE`).
It includes or depends on the third-party material listed here, each under its own licence.

## Text included in this repository

### Superpowers

The skill under `skills/systematic-debugging/` includes text adapted from the `systematic-debugging`
skill of Superpowers (https://github.com/obra/superpowers), which is used under the MIT License.
The full licence text, with its copyright notice, is in `licenses/superpowers-license`.

### Common gitattributes settings

The `.gitattributes` file begins with settings taken from the gitattributes project
(https://github.com/Danimoth/gitattributes), which is used under the MIT License. The full licence
text, with its copyright notice, is in `licenses/gitattributes-license`.

### Base Sapling

`licenses/sapling-license` is the licence notice of the Base Sapling template
(https://github.com/code-saplings/base-sapling). Any configuration file in this repository that
originates from that template remains under that notice.

## Runtime dependencies

These packages are not included in this repository. The plugin's session-start hook
(`hooks/install-cli-deps.sh`) installs them from the npm registry, and each remains under its own
licence.

| Package | Licence | Source |
|---|---|---|
| `@iconify-json/lucide` | ISC, and MIT for the icons derived from the Feather project | https://github.com/lucide-icons/lucide |
| `@stricli/core` | Apache-2.0 | https://github.com/bloomberg/stricli |
| `@terrastruct/d2` | MPL-2.0 | https://github.com/terrastruct/d2 |
| `gsap` | GSAP Standard "no charge" licence (not an open-source licence) | https://gsap.com/standard-license |
| `jsdom` | MIT | https://github.com/jsdom/jsdom |
| `mermaid` | MIT | https://github.com/mermaid-js/mermaid |
| `sharp` | Apache-2.0 | https://github.com/lovell/sharp |
| `ts-pattern` | MIT | https://github.com/gvergnaud/ts-pattern |

The walkthrough renderer also runs one package that it fetches from the npm registry with `npx`
when it renders a video, rather than through the session-start hook:

| Package | Licence | Source |
|---|---|---|
| `hyperframes` | Apache-2.0 | https://github.com/heygen-com/hyperframes |

### A note on GSAP

GSAP is not open-source software. It is distributed by its vendor under the licence linked above.
This project does not redistribute GSAP: while it renders a video, the walkthrough renderer copies
GSAP from your own installation into a temporary working directory on your machine. If you
distribute a copy made that way, the GSAP licence applies to that copy.
