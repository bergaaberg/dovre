/** The issue form's few rules beyond the kit's `.field`: a field that failed validation says so in status red. Appended to src/ui/style.ts. */
export const ISSUES_CSS = String.raw`
.field > .error { color: var(--bad); font-size: var(--fs-sm); font-weight: 500; }
.field.invalid input, .field.invalid textarea, .field.invalid select { border-color: var(--bad); }
.field > .hint > .md > :first-child { margin-top: 0; }
.field > .hint > .md > :last-child { margin-bottom: 0; }
`;
