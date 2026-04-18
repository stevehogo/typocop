/**
 * Main entry point for the sample project
 */

import { add, multiply, Calculator } from "./utils.js";

export function processData(input: number[]): number {
  let result = 0;
  for (const num of input) {
    result = add(result, num);
  }
  return result;
}

export function complexCalculation(a: number, b: number): number {
  const calc = new Calculator(a);
  return calc.multiply(b).add(10).getValue();
}

export interface DataProcessor {
  process(data: number[]): number;
}

export class DefaultProcessor implements DataProcessor {
  process(data: number[]): number {
    return processData(data);
  }
}
