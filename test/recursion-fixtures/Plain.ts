export interface Node { next: Node | null; }
// Legitimate recursion: a base case guards it and each call makes progress
// (a different argument), so no signal should fire.
export class Tree {
  walk(node: Node | null): void {
    if (!node) return;
    this.walk(node.next);
  }
}
