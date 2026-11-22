# QueueTix

QueueTix is a portfolio project for high-demand reserved-seat ticketing. Browse published events, preview their seating layouts, and sign in with Google or a demo attendee account. Organizers can prepare drafts and publish events.

- [Architecture](docs/architecture.md)

Install from the repository root with `npm ci`. Configure the workspace environment files using the examples and connect the backend to a MongoDB replica set. Run `npm run dev` to start both workspaces. The frontend serves event discovery at `/` and deployment diagnostics at `/smoke`.

Run `npm test`, `npm run lint`, and `npm run build` to check the workspaces.
