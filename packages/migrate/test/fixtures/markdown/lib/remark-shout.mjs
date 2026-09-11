// Uppercases every text node, so the output shows the plugin ran.
export default function remarkShout() {
  const walk = node => {
    if (node.type === 'text') node.value = node.value.toUpperCase()
    for (const child of node.children ?? []) walk(child)
  }
  return tree => walk(tree)
}
