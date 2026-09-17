# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run in the terminal

To talk to the agent in the terminal you are already in, with no browser and no server:

```sh
npx @deepseek-ai/dsh tui
```

The command starts one multi-turn session: replies stream in place, tool calls become foldable cards, and approvals and questions appear above the input. A first prompt on the command line is submitted as soon as the terminal is up, `--resume <session-id>` continues a persisted session instead of starting a new one, and `--no-open` prints sign-in URLs instead of opening the default browser.

```sh
npx @deepseek-ai/dsh tui "explain this repository"
npx @deepseek-ai/dsh tui --resume <session-id>
```

`Enter` sends, `Esc` stops the running turn, `Ctrl+O` expands every tool card, and `Ctrl+C` twice (or `Ctrl+D` on an empty input) quits and prints the resume command for the session. `Shift+Up` moves focus into the footer status bar, where `Left` / `Right` walk its segments, `Enter` opens the selected segment's details, and `Esc` returns to the editor. Type `/help` inside the terminal for the commands, among them `/model`, `/sessions`, `/attach`, and `/status`. See [terminal application](packages/bundle/tui-app/README.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding, and `pnpm dsh tui` starts the terminal session the same way.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
