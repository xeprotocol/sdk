// Vite serves `?raw` imports as the file's text. Used so the vector fixture
// loads identically in Node and in a browser — and, critically, so it is read
// as TEXT: a JSON module import would go through JSON.parse and round every
// uint64 in it, which is the one thing these vectors exist to catch.
declare module '*?raw' {
  const content: string
  export default content
}
