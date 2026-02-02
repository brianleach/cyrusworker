# Contributing to CyrusWorker

Thank you for your interest in contributing to CyrusWorker! This project runs [Cyrus Community Edition](https://github.com/ceedaragents/cyrus) on Cloudflare's edge infrastructure.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/cyrusworker.git`
3. Install dependencies: `npm install`
4. Copy `.dev.vars.example` to `.dev.vars` and fill in your secrets
5. Run locally: `npm run dev` (requires Docker)

## Development

### Prerequisites

- Node.js 18+
- Docker (for local development with Cloudflare Sandbox)
- A Cloudflare Workers Paid plan ($5/month) for deployment
- Anthropic API key
- GitHub PAT
- Linear workspace with OAuth application configured

### Commands

```bash
npm run dev          # Start local dev server
npm run deploy       # Deploy to Cloudflare Workers
npm run typecheck    # Run TypeScript type checking
npm run tail         # Tail production logs
```

### Code Style

- TypeScript with strict mode
- Single-file Worker architecture in `src/index.ts`
- No external frameworks - vanilla Cloudflare Workers APIs
- Minimize logging of potentially sensitive data (see HIPAA considerations in CLAUDE.md)

## Submitting Changes

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Run type checking: `npm run typecheck`
4. Test locally with `npm run dev`
5. Commit with a descriptive message
6. Push and open a Pull Request

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include relevant logs (sanitize any sensitive data)
- Describe steps to reproduce for bugs

## Related Projects

- [Cyrus Community Edition](https://github.com/ceedaragents/cyrus) - The Claude Code-powered Linear agent that runs inside CyrusWorker
- [Moltworker](https://github.com/cloudflare/moltworker) - Inspiration for running AI agents on Cloudflare Sandbox

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
