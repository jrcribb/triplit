![Triplit banner](https://www.triplit.dev/opengraph-image.png)

# Overview

[Triplit](https://www.triplit.dev) is an open-source database that syncs data between server and browser in real-time.

Triplit provides a real-time syncing datastore that you can drop into your app as a Typescript package. Triplit handles storing your data on the server and intelligently syncs your queries to your clients. **We call this type of system a “full stack database”**—you can watch our presentation to the [Local First community](https://localfirstweb.dev/) on this new paradigm [here](https://www.youtube.com/watch?v=SEB-hF1F-UU&t=1465s).

Triplit brings together:

🔄 **Real-time sync** with incremental updates and conflict resolution at the property level

🏠 **Local caching** powered by a full-fledged client-side database

💽 **Durable server-side storage** with an admin dashboard

🔌 **Pluggable storage providers** like SQLite, IndexedDB, LevelDB, Memory, etc

😃 **Optimistic updates** to make every interaction feel fast

🔗 **Relational querying** for complex data models

🛫 **Offline-mode** with automatic reconnection and consistency guarantees

🔙 **Rollback and retry management** on failed updates

🗂️ **Schemas** for data safety and Typescript autocompletion

🔐 **Authorization** that's enforced on the server for both read and writes

🤝 **Collaboration/Multiplayer** powered by [CRDTs](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type)

🏎️ **Low latency** with minimal network traffic using delta patches

📝 **Simple API** for querying and mutating data in both vanilla Javascript and React

✅ **Fully open-source!**

# Monorepo Overview

In `triplit/packages` you can find the various projects that power Triplit:

- [TriplitDB](https://github.com/aspen-cloud/triplit/tree/main/packages/db) - Designed to run in any JS environment (browser, node, deno, React Native, etc) and provide expressive, fast, and live updating queries while maintaining consistency with many writers over a network.
- [Client](https://github.com/aspen-cloud/triplit/tree/main/packages/client) - Browser library to interact with local and remote TriplitDBs.
- [CLI](https://github.com/aspen-cloud/triplit/tree/main/packages/cli) - CLI tool with commands to scaffold a project, run the full-stack development environment, migrate a server, and more.
- [React](https://github.com/aspen-cloud/triplit/tree/main/packages/react) - React bindings for @triplit/client.
- [Console](https://github.com/aspen-cloud/triplit/tree/main/packages/console) - React app for viewing and mutating data in Triplit projects and managing their schemas.
- [Server](https://github.com/aspen-cloud/triplit/tree/main/packages/server) - Node server for syncing data between Triplit clients.
- [Server-core](https://github.com/aspen-cloud/triplit/tree/main/packages/server-core) - Protocol agnostic library for building servers running Triplit.
- [Docs](https://github.com/aspen-cloud/triplit/tree/main/packages/docs) - Triplit docs, built with Nextra.
- [Types](https://github.com/aspen-cloud/triplit/tree/main/packages/types) - Shared types for various Triplit projects.
- [UI](https://github.com/aspen-cloud/triplit/tree/main/packages/ui) - Shared UI components for Triplit frontend projects, built with [shadcn](https://ui.shadcn.com/).

# Contact us

If you're interested in getting early access to Triplit Cloud (currently in developer preview), sign up [here](https://www.triplit.dev/waitlist) to join the waitlist.

The best way to get in touch is to join our [Discord](https://discord.gg/q89sGWHqQ5)! We're here to answer questions, help developers get started with Triplit and preview new features.

You can follow us on [Twitter/X](https://twitter.com/triplit_dev) to see our latest announcements.
