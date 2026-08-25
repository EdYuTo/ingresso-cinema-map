#!/usr/bin/env node
/**
 * Pure-function tests for Google Maps address → Nominatim query formatting.
 *
 * Usage: node scripts/test-geocode-format.mjs
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  expandTitleAbbreviations,
  formatGoogleAddressForGeocode,
  buildGeocodeQueryFallbacks
} = require(path.join(__dirname, '..', 'lib', 'geocode-format.js'));

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ok — ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL — ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  if (ok) {
    passed += 1;
    console.log(`  ok — ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL — ${message}`);
    console.error(`         expected: ${JSON.stringify(expected)}`);
    console.error(`         actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('expandTitleAbbreviations');
assertEqual(
  expandTitleAbbreviations('Avenida Brig. Faria Lima'),
  'Avenida Brigadeiro Faria Lima',
  'Brig. → Brigadeiro'
);
assertEqual(
  expandTitleAbbreviations('Rua Dr. Arnaldo'),
  'Rua Doutor Arnaldo',
  'Dr. → Doutor'
);
assertEqual(
  expandTitleAbbreviations('Praça Dra. Ruth Cardoso'),
  'Praça Doutora Ruth Cardoso',
  'Dra. → Doutora'
);
assertEqual(
  expandTitleAbbreviations('Av. Prof. Almeida Prado'),
  'Av. Professor Almeida Prado',
  'Prof. → Professor'
);
assertEqual(
  expandTitleAbbreviations('Rua Eng. Luís Carlos Berrini'),
  'Rua Engenheiro Luís Carlos Berrini',
  'Eng. → Engenheiro'
);
assertEqual(
  expandTitleAbbreviations('Av. Pres. Juscelino Kubitschek'),
  'Av. Presidente Juscelino Kubitschek',
  'Pres. → Presidente'
);
assertEqual(
  expandTitleAbbreviations('Rua Sen. César Lacerda'),
  'Rua Senador César Lacerda',
  'Sen. → Senador'
);
assertEqual(
  expandTitleAbbreviations('Rua Des. Eliseu Guilherme'),
  'Rua Desembargador Eliseu Guilherme',
  'Des. → Desembargador'
);

console.log('formatGoogleAddressForGeocode');
{
  const result = formatGoogleAddressForGeocode(
    'Av. Brig. Faria Lima, 949 - Pinheiros, São Paulo - SP, 05426-100'
  );
  assertEqual(
    result.query,
    'Avenida Brigadeiro Faria Lima 949, Pinheiros, São Paulo, SP, Brasil',
    'keeps Pinheiros and expands Brig. for Faria Lima share-link address'
  );
  assertEqual(
    result.street,
    'Avenida Brigadeiro Faria Lima 949',
    'exposes street for Nominatim structured search'
  );
  assertEqual(result.city, 'São Paulo', 'parses city');
  assertEqual(result.uf, 'SP', 'parses UF');
  assertEqual(result.neighborhood, 'Pinheiros', 'parses neighborhood');
}

{
  const result = formatGoogleAddressForGeocode(
    'Rua Augusta, 1500 - Consolação, São Paulo - SP, 01304-001'
  );
  assert(
    result.query.includes('1500') && result.query.includes('Consolação'),
    'keeps neighborhood after NUMBER - Neighborhood'
  );
  assertEqual(
    result.query,
    'Rua Augusta 1500, Consolação, São Paulo, SP, Brasil',
    'formats street + number + neighborhood + city'
  );
  assertEqual(result.street, 'Rua Augusta 1500', 'street is number + name only');
}

{
  const result = formatGoogleAddressForGeocode(
    'Rua da Consolação, 200, São Paulo - SP, 01302-000'
  );
  assertEqual(
    result.query,
    'Rua da Consolação 200, São Paulo, SP, Brasil',
    'plain number segment without neighborhood still works'
  );
  assertEqual(result.street, 'Rua da Consolação 200', 'street without neighborhood');
}

console.log('buildGeocodeQueryFallbacks');
{
  const raw = 'Av. Brig. Faria Lima, 949 - Pinheiros, São Paulo - SP, 05426-100';
  const candidates = buildGeocodeQueryFallbacks(raw);
  assertEqual(candidates.length, 2, 'short list: formatted free-form + lightly cleaned original');
  assertEqual(
    candidates[0],
    'Avenida Brigadeiro Faria Lima 949, Pinheiros, São Paulo, SP, Brasil',
    'primary candidate is fully formatted query'
  );
  assertEqual(
    candidates[1],
    'Avenida Brigadeiro Faria Lima, 949 - Pinheiros, São Paulo - SP, Brasil',
    'fallback expands abbreviations, strips CEP, keeps Brasil'
  );
  const unique = new Set(candidates);
  assertEqual(unique.size, candidates.length, 'fallback list has no duplicates');
}

console.log('');
if (failed) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed`);
