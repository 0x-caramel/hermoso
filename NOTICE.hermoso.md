# Hermoso: notices

## Licence

This repository is released under the **MIT licence** (see [LICENSE](LICENSE)).

- **Hermes Agent and Hermes Desktop** are copyright (c) 2025 Nous Research, MIT licensed. Their copyright and permission
  notice are kept in `LICENSE`, as the licence requires.
- **Hermoso's additions** (the files under `apps/desktop/electron/hermoso/`, `apps/desktop/src/plugins/hermoso/`,
  `apps/desktop/assets/hermoso-plugin/` and `apps/desktop/fork/`, and the documents in `docs/hermoso/` and `.github/`)
  are copyright (c) 2026 the Hermoso authors, released under the same MIT licence.

## Not covered by the MIT licence: the Hermoso portrait

The portrait of Hermoso (the anime boy with headphones: `apps/desktop/fork/brand/hermoso/source.png`, and every image
drawn from it, such as `docs/hermoso/logo.png` and the app icons) is **not** covered by the MIT licence of the code.

- It was supplied by the project's maintainer, and the rights to it belong to whoever made it, not to the code's
  contributors.
- **Before you redistribute it, make sure you may.** The simplest way to be sure is to replace it with your own art: put
  your image in `apps/desktop/fork/brand/hermoso/source.png` and run `fork/brand/hermoso.py` (see `fork/FORK.md`), which
  redraws every tile and icon from it.
- Hermoso's code works the same with any portrait.

The official Hermes artwork that the portrait is drawn onto (the tile shapes) belongs to Nous Research.

## Trademarks

- **Hermes** and **Nous Research** belong to their owners. Hermoso is an **unofficial** fork: it is not made, endorsed or
  supported by Nous Research.
- **Mullvad** is a trademark of Mullvad VPN AB. Hermoso drives the Mullvad command-line tool that is installed with the
  Mullvad app; he is not affiliated with Mullvad VPN AB and contains none of its code.
- Other names are used only to say what Hermoso works with.

## No warranty

As the licence says, the software is provided "as is". Hermoso reduces some of the risks of running an AI agent. He does
not remove them, and nothing in this repository is a security guarantee. Read the
[threat model](docs/hermoso/THREAT-MODEL.md).
