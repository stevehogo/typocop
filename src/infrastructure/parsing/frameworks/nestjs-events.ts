/**
 * Wave 6 — NestJS event-subscriber extractor (net-new capability).
 *
 * Emits structured {@link ExtractedEventSubscriber}s for:
 *   1. Method-level decorators `@EventPattern('topic')` (`nestjs-event`) and
 *      `@MessagePattern('topic')` (`nestjs-message`).
 *   2. Class-level subscriber decorators `@Processor`/`@WorkerHost`/`@Consumer`/
 *      `@RabbitSubscribe` (BullMQ/Kafka/RabbitMQ) → links the class's
 *      conventional handler method (`process`/`handleMessage`/`handle`/`execute`)
 *      with framework label `bullmq-<decorator-lowercased>`.
 *
 * Operates on the ALREADY-PARSED tree (no second `fs.readFile`, no new `Parser`).
 *
 * GRAMMAR-DRIFT FALLBACK: typocop's `tree-sitter-typescript` places a `decorator`
 * as a **preceding sibling** of its `method_definition` (inside `class_body`) and
 * as a **preceding sibling** of its `class_declaration` (inside the wrapping
 * `export_statement`/program) — NOT as a child of the decorated node. So this
 * extractor scans both layouts (child decorators AND preceding-sibling
 * decorators), mirroring the `findDecoratorBackward` fallback the NestJS-routes
 * extractor already carries.
 *
 * Provenance: ported from the legacy parser (typocop's pre-refactor parser
 * lineage). Nodes are tree-sitter raw nodes, hence `any`-typed.
 */
import type { ExtractedEventSubscriber } from "./extracted-records.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Class-level decorator names indicating a queue/event subscriber class. */
const CLASS_SUBSCRIBER_DECORATORS = new Set(["Processor", "WorkerHost", "Consumer", "RabbitSubscribe"]);

/** Conventional handler-method names inside subscriber classes. */
const HANDLER_METHOD_NAMES = new Set(["process", "handleMessage", "handle", "execute"]);

/** The call-expression function name of a `decorator` node, or null. */
function decoratorCallName(decoratorNode: any): string | null {
  const callExp = (decoratorNode.children ?? []).find((c: any) => c.type === "call_expression");
  if (!callExp) return null;
  return callExp.childForFieldName?.("function")?.text ?? null;
}

/** First string-literal argument of a `decorator`'s call (quotes stripped), or null. */
function decoratorFirstStringArg(decoratorNode: any): string | null {
  const callExp = (decoratorNode.children ?? []).find((c: any) => c.type === "call_expression");
  if (!callExp) return null;
  const argsNode = callExp.childForFieldName?.("arguments");
  if (!argsNode) return null;
  for (const arg of argsNode.children ?? []) {
    if (arg.type === "string") {
      return arg.text.substring(1, arg.text.length - 1);
    }
  }
  return null;
}

/**
 * Collect the `decorator` nodes attached to `node`: both child decorators (older
 * grammar layout) and preceding-sibling decorators inside `parent` before `node`
 * (typocop's layout).
 *
 * @param stopAtNonDecorator when true, stop at the first non-decorator sibling
 *   (the contiguous-run rule used for `method_definition`s, whose decorators sit
 *   directly before them in `class_body`). When false, scan ALL preceding
 *   siblings for decorators — needed for a `class_declaration` inside an
 *   `export_statement`, where the `export` keyword sits between the decorator and
 *   the class. There is no cross-class bleed because each class is in its own
 *   `export_statement`/statement scope.
 */
function decoratorsFor(node: any, parent: any | null, stopAtNonDecorator: boolean): any[] {
  const out: any[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "decorator") out.push(child);
  }
  if (parent && parent.children) {
    const idx = parent.children.indexOf(node);
    for (let i = idx - 1; i >= 0; i--) {
      const sib = parent.children[i];
      if (!sib) break;
      if (sib.type === "decorator") {
        out.push(sib);
      } else if (stopAtNonDecorator) {
        break;
      }
    }
  }
  return out;
}

/** Walk the tree and emit structured NestJS event subscribers. */
export function extractNestJSEvents(tree: any, filePath: string): ExtractedEventSubscriber[] {
  const events: ExtractedEventSubscriber[] = [];
  const rootNode = tree.rootNode;

  const walk = (node: any, parent: any | null, currentClass: string | null): void => {
    if (node.type === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      currentClass = nameNode ? nameNode.text : null;
      detectClassLevelSubscriber(node, parent, currentClass, filePath, events);
    }

    if (node.type === "method_definition") {
      const methodNameNode = node.childForFieldName("name");
      const methodName = methodNameNode ? methodNameNode.text : null;

      for (const dec of decoratorsFor(node, parent, true)) {
        const funcName = decoratorCallName(dec);
        if (funcName === "EventPattern" || funcName === "MessagePattern") {
          const topicName = decoratorFirstStringArg(dec);
          if (topicName) {
            events.push({
              filePath,
              topicName,
              className: currentClass,
              methodName,
              framework: funcName === "EventPattern" ? "nestjs-event" : "nestjs-message",
              lineNumber: node.startPosition.row,
            });
          }
        }
      }
    }

    for (const child of node.children ?? []) {
      walk(child, node, currentClass);
    }
  };

  walk(rootNode, null, null);

  return events;
}

/**
 * Detect class-level subscriber decorators (`@Processor('queue')`, etc.). Finds
 * the conventional handler method inside the class body and emits a subscriber
 * linking `queue` → that method (framework label `bullmq-<decorator-lowercased>`).
 */
function detectClassLevelSubscriber(
  classNode: any,
  classParent: any | null,
  className: string | null,
  filePath: string,
  events: ExtractedEventSubscriber[],
): void {
  for (const dec of decoratorsFor(classNode, classParent, false)) {
    const funcName = decoratorCallName(dec);
    if (!funcName || !CLASS_SUBSCRIBER_DECORATORS.has(funcName)) continue;

    const topicName = decoratorFirstStringArg(dec);
    if (!topicName) continue;

    const classBody = classNode.childForFieldName("body");
    if (!classBody) continue;

    let handlerMethodName: string | null = null;
    let handlerLine = classNode.startPosition.row;

    for (const member of classBody.children) {
      if (member.type === "method_definition") {
        const mName = member.childForFieldName("name")?.text;
        if (mName && HANDLER_METHOD_NAMES.has(mName)) {
          handlerMethodName = mName;
          handlerLine = member.startPosition.row;
          break;
        }
      }
    }

    events.push({
      filePath,
      topicName,
      className,
      methodName: handlerMethodName || className,
      framework: `bullmq-${funcName.toLowerCase()}`,
      lineNumber: handlerLine,
    });
  }
}
