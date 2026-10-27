import { Parser, Language } from "web-tree-sitter"
import { createRequire } from "module"
const require = createRequire(process.argv[2] + "/")
await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm") })
const lang = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"))
const p = new Parser(); p.setLanguage(lang)
const dump = (n: any, d = 0): string => "  ".repeat(d) + n.type + (n.isNamed ? "" : " (anon)") + " " + JSON.stringify(n.text) + "\n" + Array.from({ length: n.childCount }, (_, i) => dump(n.child(i), d + 1)).join("")
for (const c of [
  String.raw`cat '/a/pro\j/x'`,
  String.raw`cat "/a/pro\j/x"`,
  String.raw`cat "/a/q\"x\\y/\$z"`,
  String.raw`cat pro'\j'/x`,
  String.raw`cat "a"\ b`,
  String.raw`cat my\ dir/x`,
  String.raw`cat ""`,
  String.raw`cat "a b" ''`,
  String.raw`cat $'a\tb' "x$HOME/y" "a\`b"`,
  String.raw`cat ~/x "~/x" a"b c"d`,
  "cat \"a\\\nb\" c\\\nd",
  String.raw`cat " lead" "trail "`,
]) console.log("### " + c + "\n" + dump(p.parse(c)!.rootNode))
