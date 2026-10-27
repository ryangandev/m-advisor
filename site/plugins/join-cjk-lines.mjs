// The Markdown sources keep one sentence per line. A soft line break renders as a space in HTML,
// which is right between English words but leaves a visible gap between Chinese sentences.
// This mdast plugin drops a soft line break when the characters on both sides are CJK
// (ideographs, CJK or full-width punctuation, or an ellipsis) and keeps it next to ASCII words.
const CJK = /[·…⺀-鿿豈-﫿︰-﹏＀-￯]/u;

const isCjk = (char) => char !== undefined && CJK.test(char);

export const joinCjkLines = {
  name: "join-cjk-lines",
  text(node, ctx) {
    const value = node.value;
    if (!value.includes("\n")) return;
    const parent = ctx.parent(node);
    const index = ctx.indexOf(node);
    const edge = (sibling, last) => {
      if (!sibling) return undefined;
      const text = typeof sibling.value === "string" ? sibling.value : ctx.textContent(sibling);
      return last ? text.at(-1) : text[0];
    };
    const before = () => edge(parent?.children[index - 1], true);
    const after = () => edge(parent?.children[index + 1], false);
    let result = "";
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === "\n") {
        const previous = i > 0 ? value[i - 1] : before();
        const next = i < value.length - 1 ? value[i + 1] : after();
        if (isCjk(previous) && isCjk(next)) continue;
      }
      result += value[i];
    }
    if (result !== value) ctx.setProperty(node, "value", result);
  },
};
