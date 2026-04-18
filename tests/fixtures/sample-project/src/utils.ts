/**
 * Utility functions for the sample project
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export class Calculator {
  private value: number = 0;

  constructor(initialValue: number = 0) {
    this.value = initialValue;
  }

  add(n: number): Calculator {
    this.value += n;
    return this;
  }

  multiply(n: number): Calculator {
    this.value *= n;
    return this;
  }

  getValue(): number {
    return this.value;
  }
}
