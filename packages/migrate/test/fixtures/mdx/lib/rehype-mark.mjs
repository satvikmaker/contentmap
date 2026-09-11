// Gives every h1 a class, so the output shows the plugin ran with its options.
export default function rehypeMark(options = {}) {
  const walk = node => {
    if (node.type === 'element' && node.tagName === 'h1') {
      node.properties = { ...node.properties, className: [options.className ?? 'marked'] }
    }
    for (const child of node.children ?? []) walk(child)
  }
  return tree => walk(tree)
}
