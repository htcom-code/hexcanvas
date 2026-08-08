// TypeScript 7 refuses a side-effect import it has no declaration for (TS2882), which
// `import "./styles.css"` is: the bundler turns it into a stylesheet and there is nothing
// for the type system to know about it. Declaring the pattern is the whole answer.
//
// `vite/client` declares the same thing, but vite is a dependency of the playground alone
// and does not resolve from the repository root, where the test project type-checks this
// file as well — so the declaration lives here rather than in a `types` entry.
declare module "*.css";
