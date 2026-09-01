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
  buildGeocodeQueryFallbacks,
  pickGeocodeMatch,
  buildHouseNumberProbes,
  shouldRefineSuggestion
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

{
  const result = formatGoogleAddressForGeocode(
    'R. Augusta, 901 - Consolação, São Paulo - SP, 01305-100'
  );
  assertEqual(result.cep, '01305-100', 'keeps the CEP so geocoding can disambiguate the street');
  assertEqual(result.number, '901', 'keeps the house number for verifying geocoder matches');
}

{
  const result = formatGoogleAddressForGeocode('Rua Augusta, 901 - Consolação, São Paulo - SP');
  assertEqual(result.cep, null, 'cep is null when the address has none');
}

{
  const result = formatGoogleAddressForGeocode(
    'R. Augusta, 901 - Consolação, São Paulo - SP, 01305100'
  );
  assertEqual(result.cep, '01305-100', 'normalizes an unhyphenated CEP');
}

{
  const result = formatGoogleAddressForGeocode('av brigadeiro faria lima 949, pinheiros');
  assertEqual(result.number, '949', 'reads a number glued to the end of the street segment');
  assertEqual(result.neighborhood, 'pinheiros', 'treats the trailing segment as the neighbourhood');
  assertEqual(result.street, 'av brigadeiro faria lima 949', 'street keeps the number, drops the neighbourhood');
  assertEqual(result.city, null, 'no city when the user did not type one');
}

{
  const result = formatGoogleAddressForGeocode('Avenida Paulista 1578');
  assertEqual(result.number, '1578', 'reads the number from a single-segment address');
  assertEqual(result.neighborhood, null, 'a single segment has no neighbourhood');
}

{
  const result = formatGoogleAddressForGeocode('Rua 25 de Março, Centro');
  assertEqual(result.number, null, 'a number inside the street name is not a house number');
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


console.log('pickGeocodeMatch');
{
  const formatted = formatGoogleAddressForGeocode(
    'R. Augusta, 901 - Consolação, São Paulo - SP, 01305-100'
  );

  const withHouse = [
    { lat: '-23.5661', lon: '-46.6685', address: { city: 'São Paulo', postcode: '01427-970' } },
    { lat: '-23.5526', lon: '-46.6544', address: { house_number: '901', city: 'São Paulo', postcode: '01305-100' } }
  ];
  const houseMatch = pickGeocodeMatch(withHouse, formatted);
  assertEqual(houseMatch.precision, 'house', 'house-number hit wins over street segments');
  assertEqual(houseMatch.match.lat, '-23.5526', 'returns the house-number result');

  const segmentsOnly = [
    { lat: '-23.5661', lon: '-46.6685', address: { city: 'São Paulo', postcode: '01427-970' } },
    { lat: '-23.5515', lon: '-46.6510', address: { city: 'São Paulo', postcode: '01305-000' } }
  ];
  const cepMatch = pickGeocodeMatch(segmentsOnly, formatted);
  assertEqual(cepMatch.precision, 'cep-block', 'falls back to the segment sharing the CEP prefix');
  assertEqual(cepMatch.match.lat, '-23.5515', 'returns the CEP-prefix segment, not the first result');

  const exactCep = [
    { lat: '-23.5515', lon: '-46.6510', address: { city: 'São Paulo', postcode: '01305-000' } },
    { lat: '-23.5544', lon: '-46.6559', address: { city: 'São Paulo', postcode: '01305-100' } }
  ];
  const exact = pickGeocodeMatch(exactCep, formatted);
  assertEqual(exact.precision, 'cep', 'the exact CEP beats another CEP in the same block');
  assertEqual(exact.match.lat, '-23.5544', 'returns the exact-CEP result');

  const otherCity = [
    { lat: '-22.8543', lon: '-47.1889', address: { house_number: '901', city: 'Hortolândia', postcode: '13181-670' } }
  ];
  assertEqual(
    pickGeocodeMatch(otherCity, formatted),
    null,
    'discards a house-number hit in another city'
  );

  const guarulhos = [{
    lat: '-23.4468988',
    lon: '-46.5211920',
    display_name: '949, Avenida Brigadeiro Faria Lima, Vila Cocaia, Guarulhos, São Paulo, Região Sudeste, 07130-000, Brasil',
    address: { house_number: '901', city: 'Guarulhos', state: 'São Paulo', postcode: '07130-000' }
  }];
  assertEqual(
    pickGeocodeMatch(guarulhos, formatted),
    null,
    'the state name in display_name does not smuggle in a result from another city'
  );

  const cityOnly = [
    { lat: '-23.5661', lon: '-46.6685', address: { city: 'São Paulo', postcode: '01427-970' } }
  ];
  const loose = pickGeocodeMatch(cityOnly, formatted);
  assertEqual(loose.precision, 'city', 'street segment in the right city is the weakest usable match');

  assertEqual(pickGeocodeMatch([], formatted), null, 'no results means no match');
}

console.log('buildHouseNumberProbes');
{
  assertEqual(
    buildHouseNumberProbes('901', 6).join(','),
    '900,902,899,903,898,904',
    'probes by distance, crossing parity — the neighbour opposite can be the closest one'
  );
  assertEqual(
    buildHouseNumberProbes('4', 6).join(','),
    '3,5,2,6,1,7',
    'skips numbers below 1 near the start of a street and still fills the budget'
  );
  assertEqual(buildHouseNumberProbes(null).join(','), '', 'no number means no probes');
  assertEqual(buildHouseNumberProbes('sem numero').join(','), '', 'non-numeric input means no probes');
}

console.log('shouldRefineSuggestion');
{
  const typed = formatGoogleAddressForGeocode('av brigadeiro faria lima 949, pinheiros');

  assertEqual(
    shouldRefineSuggestion({ address: { road: 'Avenida Brigadeiro Faria Lima' } }, typed),
    true,
    'a suggestion without a house number is a street segment and needs refining'
  );
  assertEqual(
    shouldRefineSuggestion({ address: { house_number: '952', road: 'Avenida Brigadeiro Faria Lima' } }, typed),
    false,
    'a suggestion that already carries a house number is kept as is'
  );
  assertEqual(
    shouldRefineSuggestion({ display_name: 'Casa', lat: '-23.5', lon: '-46.6' }, typed),
    false,
    'a saved address has no geocoder details and must never be re-geocoded'
  );
  assertEqual(
    shouldRefineSuggestion(
      { address: { road: 'Avenida Paulista' } },
      formatGoogleAddressForGeocode('avenida paulista')
    ),
    false,
    'nothing to refine when the user typed no house number'
  );
}

console.log('');
if (failed) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed`);
