// Files imported `with { type: "text" }` and embedded in the compiled binary.
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.env.example" {
  const text: string;
  export default text;
}
