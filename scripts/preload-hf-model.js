#!/usr/bin/env node

/**
 * Preload HuggingFace embedding model to cache before indexing.
 * 
 * Usage:
 *   node scripts/preload-hf-model.js
 *   node scripts/preload-hf-model.js --model mixedbread-ai/mxbai-embed-large-v1
 *   node scripts/preload-hf-model.js --dtype fp16
 *   node scripts/preload-hf-model.js --test
 */

import { pipeline } from '@huggingface/transformers';

const args = process.argv.slice(2);
const model = args.includes('--model') 
  ? args[args.indexOf('--model') + 1] 
  : 'mixedbread-ai/mxbai-embed-large-v1';

const dtype = args.includes('--dtype')
  ? args[args.indexOf('--dtype') + 1]
  : 'fp32';

const runTest = args.includes('--test');

console.log(`🔄 Preloading HuggingFace model: ${model}`);
console.log(`   Data type: ${dtype}`);
console.log(`   Cache location: ~/.cache/huggingface/hub/`);
console.log('');

try {
  const extractor = await pipeline('feature-extraction', model, { dtype });
  console.log('✅ Model downloaded and cached successfully');
  console.log('');

  if (runTest) {
    console.log('🧪 Testing embedding generation...');
    console.log('');

    const testCases = [
      { text: 'function myFunction', kind: 'function' },
      { text: 'class MyClass', kind: 'class' },
      { text: 'const variable = 42', kind: 'variable' },
      { text: 'async method(param: string)', kind: 'method' },
      { text: 'export interface IService', kind: 'interface' },
      { text: 'type CustomType = string | number', kind: 'type' },
      { text: 'enum Status { Active, Inactive }', kind: 'enum' },
      { text: 'public readonly property: string', kind: 'property' },
    ];

    let totalTime = 0;
    let successCount = 0;
    let failureCount = 0;

    for (const testCase of testCases) {
      try {
        const start = Date.now();
        const result = await extractor(testCase.text, { pooling: 'cls' });
        const duration = Date.now() - start;
        totalTime += duration;
        successCount++;

        const vector = result.tolist()[0];
        const dimensions = vector.length;
        console.log(`  ✓ ${testCase.kind.padEnd(12)} → ${duration.toString().padStart(3)}ms (${dimensions} dims)`);
      } catch (err) {
        failureCount++;
        console.log(`  ✗ ${testCase.kind.padEnd(12)} → Error: ${err.message}`);
      }
    }

    console.log('');
    console.log('📊 Test Results:');
    console.log(`   Total tests: ${testCases.length}`);
    console.log(`   Passed: ${successCount}`);
    console.log(`   Failed: ${failureCount}`);
    console.log(`   Average time: ${(totalTime / successCount).toFixed(0)}ms per embedding`);
    console.log(`   Total time: ${totalTime}ms`);
    console.log('');

    if (failureCount === 0) {
      console.log('✅ All embedding tests passed!');
    } else {
      console.log(`⚠️  ${failureCount} test(s) failed`);
    }
  }

  console.log('');
  console.log('You can now run indexing with embeddings enabled:');
  console.log('  EMBEDDING_PROVIDER=huggingface typocop parse -p ./src/');
  console.log('');
  
  await extractor.dispose();
  process.exit(0);
} catch (err) {
  console.error('❌ Error downloading model:');
  console.error(`   ${err.message}`);
  console.error('');
  console.error('Troubleshooting:');
  console.error('  1. Check internet connection');
  console.error('  2. Verify HuggingFace Hub is accessible');
  console.error('  3. Check disk space (~1GB required)');
  console.error('  4. Check ~/.cache/huggingface/hub/ permissions');
  console.error('');
  process.exit(1);
}
