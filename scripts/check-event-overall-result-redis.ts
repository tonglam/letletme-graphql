#!/usr/bin/env bun

/**
 * Debug script to check EventOverallResult keys in Redis
 */

import { connectRedis } from '../src/infra/redis';

async function checkRedis(): Promise<void> {
  try {
    console.log('🔍 Checking Redis for EventOverallResult keys...\n');
    
    const redis = await connectRedis();
    
    console.log('🔎 Searching for all EventOverallResult keys...\n');
    
    // Find all EventOverallResult keys
    const pattern = 'EventOverallResult:*';
    const keys = await redis.keys(pattern);
    
    if (keys.length === 0) {
      console.log('❌ No EventOverallResult keys found in Redis');
      console.log('\n💡 Make sure data is being written to Redis with the key format: EventOverallResult:{season}');
    } else {
      console.log(`✅ Found ${keys.length} EventOverallResult key(s):\n`);
      keys.sort().forEach((key, index) => {
        console.log(`   ${index + 1}. ${key}`);
      });
      
      // Show details of all keys
      for (const key of keys) {
        console.log(`\n📊 Details of key: ${key}`);
        
        // Check the type of the key
        const keyType = await redis.type(key);
        console.log(`   Redis data type: ${keyType}`);
        
        let value: string | null = null;
        
        try {
          if (keyType === 'string') {
            value = await redis.get(key);
          } else if (keyType === 'hash') {
            console.log(`   ⚠️  Key is a hash, getting all fields...`);
            const hashData = await redis.hgetall(key);
            console.log(`   Hash fields: ${Object.keys(hashData).length} fields`);
            if (Object.keys(hashData).length > 0) {
              console.log(`   Sample field keys: ${Object.keys(hashData).slice(0, 10).join(', ')}`);
              const firstFieldKey = Object.keys(hashData)[0];
              const firstFieldValue = hashData[firstFieldKey];
              console.log(`   Sample field value (${firstFieldKey}):`, firstFieldValue?.substring(0, 200));
            }
            value = JSON.stringify(hashData);
          } else if (keyType === 'list') {
            console.log(`   ⚠️  Key is a list, getting all items...`);
            const listLength = await redis.llen(key);
            const listData = await redis.lrange(key, 0, -1);
            console.log(`   List length: ${listLength}`);
            if (listData.length > 0) {
              console.log(`   Sample item:`, listData[0]?.substring(0, 200));
            }
            value = JSON.stringify(listData);
          } else if (keyType === 'set') {
            console.log(`   ⚠️  Key is a set, getting all members...`);
            const setData = await redis.smembers(key);
            console.log(`   Set size: ${setData.length}`);
            if (setData.length > 0) {
              console.log(`   Sample member:`, setData[0]?.substring(0, 200));
            }
            value = JSON.stringify(setData);
          } else {
            console.log(`   ⚠️  Unknown Redis type: ${keyType}`);
          }
          
          if (value) {
            try {
              const data = JSON.parse(value);
              if (Array.isArray(data)) {
                console.log(`   ✅ Valid array with ${data.length} items`);
                if (data.length > 0) {
                  console.log(`   Sample item:`, JSON.stringify(data[0], null, 2));
                }
              } else if (typeof data === 'object' && data !== null) {
                console.log(`   ✅ Valid object`);
                console.log(`   Object keys: ${Object.keys(data).join(', ')}`);
                console.log(`   Sample data:`, JSON.stringify(data, null, 2).substring(0, 500));
              } else {
                console.log(`   ⚠️  Data type: ${typeof data}`);
                console.log(`   Data preview:`, JSON.stringify(data).substring(0, 500));
              }
            } catch (e) {
              console.log(`   ⚠️  Could not parse as JSON: ${e instanceof Error ? e.message : String(e)}`);
              console.log(`   Raw value preview: ${value.substring(0, 500)}`);
            }
          }
        } catch (e) {
          console.log(`   ❌ Error reading key: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    
    await redis.quit();
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

checkRedis();
