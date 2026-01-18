#!/usr/bin/env bun

/**
 * Debug script to check PlayerValue keys in Redis
 */

import { connectRedis } from '../src/infra/redis';

function getTodayKey(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `PlayerValue:${year}${month}${day}`;
}

async function checkRedis(): Promise<void> {
  try {
    console.log('🔍 Checking Redis for PlayerValue keys...\n');
    
    const redis = await connectRedis();
    
    // Get today's expected key
    const todayKey = getTodayKey();
    console.log(`📅 Today's expected key: ${todayKey}\n`);
    
    // Check if today's key exists
    const todayValue = await redis.get(todayKey);
    if (todayValue) {
      console.log(`✅ Found today's key: ${todayKey}`);
      try {
        const data = JSON.parse(todayValue);
        console.log(`   Data type: ${Array.isArray(data) ? 'Array' : typeof data}`);
        if (Array.isArray(data)) {
          console.log(`   Array length: ${data.length}`);
          if (data.length > 0) {
            console.log(`   First item keys: ${Object.keys(data[0]).join(', ')}`);
          }
        }
      } catch (e) {
        console.log(`   ⚠️  Could not parse as JSON`);
      }
    } else {
      console.log(`❌ Today's key not found: ${todayKey}`);
    }
    
    console.log('\n🔎 Searching for all PlayerValue keys...\n');
    
    // Find all PlayerValue keys
    const pattern = 'PlayerValue:*';
    const keys = await redis.keys(pattern);
    
    if (keys.length === 0) {
      console.log('❌ No PlayerValue keys found in Redis');
      console.log('\n💡 Make sure data is being written to Redis with the key format: PlayerValue:yyyyMMdd');
    } else {
      console.log(`✅ Found ${keys.length} PlayerValue key(s):\n`);
      keys.sort().forEach((key, index) => {
        console.log(`   ${index + 1}. ${key}`);
      });
      
      // Show details of the most recent key
      const mostRecentKey = keys.sort().reverse()[0];
      console.log(`\n📊 Details of most recent key: ${mostRecentKey}`);
      
      // Check the type of the key
      const keyType = await redis.type(mostRecentKey);
      console.log(`   Redis data type: ${keyType}`);
      
      let value: string | null = null;
      
      try {
        if (keyType === 'string') {
          value = await redis.get(mostRecentKey);
        } else if (keyType === 'hash') {
          console.log(`   ⚠️  Key is a hash, getting all fields...`);
          const hashData = await redis.hgetall(mostRecentKey);
          console.log(`   Hash fields: ${Object.keys(hashData).length} fields`);
          value = JSON.stringify(hashData);
        } else if (keyType === 'list') {
          console.log(`   ⚠️  Key is a list, getting all items...`);
          const listLength = await redis.llen(mostRecentKey);
          const listData = await redis.lrange(mostRecentKey, 0, -1);
          console.log(`   List length: ${listLength}`);
          value = JSON.stringify(listData);
        } else if (keyType === 'set') {
          console.log(`   ⚠️  Key is a set, getting all members...`);
          const setData = await redis.smembers(mostRecentKey);
          console.log(`   Set size: ${setData.length}`);
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
            } else {
              console.log(`   ⚠️  Not an array, type: ${typeof data}`);
              console.log(`   Data preview:`, JSON.stringify(data).substring(0, 200));
            }
          } catch (e) {
            console.log(`   ⚠️  Could not parse as JSON: ${e instanceof Error ? e.message : String(e)}`);
            console.log(`   Raw value preview: ${value.substring(0, 200)}`);
          }
        }
      } catch (e) {
        console.log(`   ❌ Error reading key: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    
    await redis.quit();
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

checkRedis();
