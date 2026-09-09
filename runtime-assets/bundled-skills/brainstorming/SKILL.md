---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
triggers: ["(create|build|design) (a |an |the |a new |an entirely )?(new )?(feature|component|tool|module|app|screen|page|ui|skill|project)", "from scratch", "greenfield", "设计", "新功能", "新特性", "新建(功能|模块|组件)", "头脑风暴", "brainstorm(ing)?"]
---
# Brainstorming Ideas Into Designs

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.

Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

You MUST create a task for each of these items and complete them in order:

1. **Explore project context** — check files, docs, recent commits
2. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
3. **Propose 2-3 approaches** — with trade-offs and your recommendation
4. **Present design** — in sections scaled to their complexity, get user approval after each section
5. **Write design doc** — save to `docs/superpowers/specs/YYYY-MM-DD--design.md` and commit
6. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
7. **User reviews written spec** — ask user to review the spec file before proceeding
8. **Transition to planning** — create the implementation plan with the built-in `plan` tool (`plan action=enter_mode` → write plan → `plan action=submit`) and get it approved

## Process Flow

```dot
digraph brainstorming {
"Explore project context" [shape=box];
"Ask clarifying questions" [shape=box];
"Propose 2-3 approaches" [shape=box];
"Present design sections" [shape=box];
"User approves design?" [shape=diamond];
"Write design doc" [shape=box];
"Spec self-review\n(fix inline)" [shape=box];
"User reviews spec?" [shape=diamond];
"Create implementation plan\n(plan tool submit)" [shape=doublecircle];

"Explore project context" -> "Ask clarifying questions";
"Ask clarifying questions" -> "Propose 2-3 approaches";
"Propose 2-3 approaches" -> "Present design sections";
"Present design sections" -> "User approves design?";
"User approves design?" -> "Present design sections" [label="no, revise"];
"User approves design?" -> "Write design doc" [label="yes"];
"Write design doc" -> "Spec self-review\n(fix inline)";
"Spec self-review\n(fix inline)" -> "User reviews spec?";
"User reviews spec?" -> "Write design doc" [label="changes requested"];
"User reviews spec?" -> "Create implementation plan\n(plan tool submit)" [label="approved"];
}
```

**The terminal state is an approved implementation plan.** Do NOT jump into code after the spec is approved. Use the built-in `plan` tool to write the implementation plan (with TDD steps and per-wave verification commands) and submit it with `plan action=submit` for user approval. Code only after the plan is approved.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems (e.g., "build a platform with chat, file storage, billing, and analytics"), flag this immediately. Don't spend questions refining details of a project that needs to be decomposed first.
- If the project is too large for a single spec, help the user decompose into sub-projects: what are the independent pieces, how do they relate, what order should they be built? Then brainstorm the first sub-project through the normal design flow. Each sub-project gets its own spec → plan → implementation cycle.
- For appropriately-scoped projects, ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
- For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.
- Smaller, well-bounded units are also easier for you to work with - you reason better about code you can hold in context at once, and your edits are more reliable when files are focused. When a file grows large, that's often a signal that it's doing too much.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design - the way a good developer improves code they're working in.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

**Documentation:**

- Write the validated design (spec) to `docs/superpowers/specs/YYYY-MM-DD--design.md`
- (User preferences for spec location override this default)
- Use a style/concise-writing skill if one is available
- Commit the design document to git

**Spec Self-Review:**

After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate:**

After the spec review loop passes, ask the user to review the written spec before proceeding:

> "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan."

Wait for the user's response. If they request changes, make them and re-run the spec review loop. Only proceed once the user approves.

**Planning:**

- Create the implementation plan with the built-in `plan` tool: `plan action=enter_mode` opens planning mode (writes are locked), write the plan document, then `plan action=submit` hands it to the user for approval. Include TDD steps and concrete verification commands per wave (this is the native successor of the retired writing-plans skill).
- Do NOT skip this step and do NOT invoke any other skill here — an approved design without an approved plan is not ready to implement.

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design, get approval before moving on
- **Be flexible** - Go back and clarify when something doesn't make sense
