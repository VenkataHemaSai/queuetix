# QueueTix repository rules

- Read the latest consolidated build brief, especially §§20.14 and 21, then docs/PROGRESS.md before coding. §20 governs technical invariants, §20.14 amends it, and §21 governs the frontend.
- Work within one explicitly authorized milestone and stop at its gate. Keep JavaScript, npm workspaces, a single backend, and the specified free tiers.
- Keep the QueueTix name centrally configurable. Use the editorial event-commerce design, with semantic tokens for warm paper, ink, and evergreen. Use Instrument Sans for UI and Newsreader for selective editorial headings.
- Use shared UI patterns, mobile-first layout, visible keyboard focus, accessible and responsive SVG seat interaction, reliable timers, reduced motion and meaningful loading and error states. Avoid gratuitous decoration, emojis and style-only dependencies.
- Treat booking, queue position, seat ownership and payment as server-authoritative. Label demo, simulation, empty and unavailable states honestly. Use measured evidence for claims and actual browser checks where available.
- Write risky tests first. Run relevant checks, record PASS, FAIL or NOT RUN in docs/PROGRESS.md, and give a concise explanation. Preserve accepted regression tests.
- Keep secrets, unlicensed assets and misleading simulation output out of Git. Report the exact sanitized failure if a conflict or free-tier limit blocks the milestone.
- Write short comments only where they explain non-obvious logic, decisions, concurrency or edge cases. Preserve comments needed to understand complex behavior.
