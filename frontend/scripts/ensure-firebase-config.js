#!/usr/bin/env node
/**
 * Ensures src/environments/firebase.config.ts exists before Angular runs.
 *
 * Local dev (npm start): uses your gitignored firebase.config.ts if present.
 * Production build: fetches FIREBASE_WEB_CONFIG from Secret Manager via Firebase CLI.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { projectId, secretName, webAppId } = require('./firebase-project');

const fromSecrets = process.argv.includes('--from-secrets');
const configPath = path.join(__dirname, '../src/environments/firebase.config.ts');
const examplePath = path.join(__dirname, '../src/environments/firebase.config.example.ts');
const messagingSwPath = path.join(__dirname, '../src/firebase-messaging-sw.js');

function writeMessagingSw(config) {
  const json = JSON.stringify(
    {
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      storageBucket: config.storageBucket,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId,
    },
    null,
    2
  );
  fs.writeFileSync(
    messagingSwPath,
    `/* Generated — do not edit */\nimportScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');\nimportScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');\nfirebase.initializeApp(${json});\nfirebase.messaging();\n`
  );
}

function writeConfigTs(config) {
  const ts = JSON.stringify(config, null, 2).replace(/"([^"]+)":/g, '$1:');
  fs.writeFileSync(
    configPath,
    '/** Generated from Google Secret Manager — DO NOT COMMIT */\n' +
      `export const firebaseConfig = ${ts};\n`
  );
  writeMessagingSw(config);
}

function fetchFromSecretManager() {
  const json = execSync(
    `firebase functions:secrets:access ${secretName} --project=${projectId}`,
    { encoding: 'utf8' }
  );
  return JSON.parse(json.trim());
}

function fetchFromFirebaseCli() {
  const output = execSync(
    `firebase apps:sdkconfig WEB ${webAppId} --project=${projectId}`,
    { encoding: 'utf8' }
  );
  const initializeMatch = output.match(/firebase\.initializeApp\((\{[\s\S]*?\})\);/);
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  const raw = initializeMatch?.[1] ?? jsonMatch?.[0];
  if (!raw) {
    throw new Error('Could not parse firebase apps:sdkconfig output');
  }
  const config = JSON.parse(raw);
  delete config.projectNumber;
  delete config.version;
  return config;
}

if (fromSecrets) {
  if (process.env.FIREBASE_WEB_CONFIG) {
    try {
      const config = JSON.parse(process.env.FIREBASE_WEB_CONFIG);
      writeConfigTs(config);
      console.log('Wrote firebase.config.ts from FIREBASE_WEB_CONFIG env.');
      process.exit(0);
    } catch (err) {
      console.error('FIREBASE_WEB_CONFIG is set but not valid JSON.');
      if (err.message) console.error(err.message);
      process.exit(1);
    }
  }

  if (!process.env.FIREBASE_TOKEN && !process.env.CI) {
    // Local --from-secrets without token may still use logged-in CLI below.
  } else if (process.env.CI && !process.env.FIREBASE_TOKEN) {
    console.error('CI deploy requires FIREBASE_TOKEN or FIREBASE_WEB_CONFIG.');
    process.exit(1);
  }

  try {
    const config = fetchFromSecretManager();
    writeConfigTs(config);
    console.log(`Fetched Firebase config from Secret Manager (${projectId}).`);
  } catch (secretErr) {
    try {
      const config = fetchFromFirebaseCli();
      writeConfigTs(config);
      console.log(
        `Secret ${secretName} not found. Fetched Firebase config via Firebase CLI instead.`
      );
      console.log('Run: npm run secrets:setup to store it in Secret Manager.');
    } catch (cliErr) {
      console.error('Could not fetch Firebase config.');
      console.error('Run: npm run firebase:setup');
      console.error('Ensure you are logged in: firebase login');
      if (secretErr.message) {
        console.error(secretErr.message);
      }
      if (cliErr.message) {
        console.error(cliErr.message);
      }
      process.exit(1);
    }
  }
  process.exit(0);
}

if (fs.existsSync(configPath)) {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const match = text.match(/firebaseConfig\s*=\s*(\{[\s\S]*\});?\s*$/);
    if (match) {
      const config = Function(`"use strict"; return (${match[1]})`)();
      writeMessagingSw(config);
    }
  } catch {
    /* keep existing service worker */
  }
  console.log('Using local firebase.config.ts for development.');
  process.exit(0);
}

console.warn(
  'Missing src/environments/firebase.config.ts for local development.\n' +
    `Copy ${path.relative(process.cwd(), examplePath)} and add your Firebase web app values.\n` +
    'Or run: npm run secrets:fetch'
);
