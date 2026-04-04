/**
 * Framework-specific parsers.
 * Requirements: 14.1-14.8
 */
export { parseMagento2File, MAGENTO2_SUPPORT } from "./magento2.js";
export { parseNestJSFile, NESTJS_SUPPORT } from "./nestjs.js";
export { parseLaravelFile, LARAVEL_SUPPORT } from "./laravel.js";
export { parseExpressFile, EXPRESS_SUPPORT } from "./express.js";
export { parseFastifyFile, FASTIFY_SUPPORT } from "./fastify.js";
export { parseORMModels } from "./orm.js";
