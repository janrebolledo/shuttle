# Project rules

- Never create, add, or run tests in this repository. Do not introduce test files, test suites, test frameworks, test scripts, or test configuration.
- Use type checking and builds for validation when needed.
- Use Lisse-generated corners for rounded surfaces. Do not use CSS `border-radius` except on tiny indicators where Lisse clipping visibly deforms the shape; mark Lisse-rounded elements with `data-corner` so the shared updater can shape a separate background surface without clipping content.
