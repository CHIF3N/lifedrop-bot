// Known towns for location matching. Easy to extend: add a town, an alias (other name or
// common spelling) or an area (neighbourhood / quarter people type instead of the town).
// Coordinates are approximate town centres (public map data, rounded).
// Typos are handled in geo.js, so only list real alternative names here, not every misspelling.
// An area listed under two towns (e.g. "Mile 4") is treated as ambiguous and the user is asked.

module.exports = [
  // South-West (Fako and around)
  {
    name: 'Buea', lat: 4.1527, lng: 9.2410,
    areas: ['Molyko', 'Great Soppo', 'Small Soppo', 'Soppo', 'Bokwango', 'Buea Town', 'Muea', 'Mile 16', 'Mile 17',
      'Mile 15', 'Bomaka', 'Bonduma', 'Clerks Quarter', 'Check Point', 'Bwitingi', 'Bolifamba', 'Sandpit',
      'Bova', 'Federal Quarter', 'Wonya Mavio', 'Bokova', 'Likoko', 'Bwassa', 'Dirty South', 'Malingo']
  },
  {
    name: 'Limbe', lat: 4.0167, lng: 9.2000, aliases: ['Victoria'],
    areas: ['Down Beach', 'Bota', 'Mabeta', 'Ngeme', 'Batoke', 'Mile 2', 'Middle Farms', 'Cassava Farms',
      'Bonadikombo', 'Unity Quarter', 'Towe', 'Busumbu', 'Mukundange', 'Moliwe', 'Saker Baptist', 'Mile 4']
  },
  { name: 'Tiko', lat: 4.0750, lng: 9.3600, areas: ['Likomba', 'Holforth', 'Mondoni', 'Missellele', 'Ombe', 'Long Street'] },
  { name: 'Mutengene', lat: 4.0910, lng: 9.3140, areas: ['Mutengene Junction'] },
  { name: 'Muyuka', lat: 4.2897, lng: 9.4103 },
  { name: 'Idenau', lat: 4.2167, lng: 8.9833 },
  {
    name: 'Kumba', lat: 4.6363, lng: 9.4469,
    areas: ['Fiango', 'Kosala', 'Mambanda', 'Three Corners', 'Kake', 'Barombi', 'Mbonge Road', 'Buea Road', 'Kumba Town', 'Kossala']
  },
  { name: 'Mamfe', lat: 5.7667, lng: 9.2833 },

  // Littoral
  {
    name: 'Douala', lat: 4.0511, lng: 9.7679, aliases: ['Dla'],
    areas: ['Akwa', 'Akwa Nord', 'Bonanjo', 'Bonapriso', 'Deido', 'Bonaberi', 'Bepanda', 'Makepe', 'Bonamoussadi',
      'Logbessou', 'Kotto', 'Ndokoti', 'New Bell', 'Yassa', 'Japoma', 'Logpom', 'Ndogbong', 'Cite des Palmiers',
      'Nyalla', 'Bonadibong', 'Bonamikano', 'Ndogpassi', 'PK8', 'PK10', 'PK12', 'PK14', 'Mboppi',
      'Ange Raphael', 'Koumassi', 'Bessengue', 'Nkongmondo', 'Bilongue', 'Mabanda', 'Sodiko', 'Grand Hangar']
  },
  { name: 'Edea', lat: 3.8000, lng: 10.1333 },
  { name: 'Nkongsamba', lat: 4.9547, lng: 9.9404 },

  // South / Centre / East
  { name: 'Kribi', lat: 2.9400, lng: 9.9100 },
  {
    name: 'Yaounde', lat: 3.8480, lng: 11.5021, aliases: ['Yde', 'Ydé'],
    areas: ['Bastos', 'Mvog-Mbi', 'Mvog-Ada', 'Mvog-Atangana Mballa', 'Biyem-Assi', 'Mendong', 'Nsimeyong', 'Essos',
      'Mokolo', 'Melen', 'Ngoa-Ekelle', 'Emana', 'Nkolbisson', 'Ekounou', 'Odza', 'Mvan', 'Etoudi', 'Omnisport',
      'Mimboman', 'Nlongkak', 'Elig-Essono', 'Tsinga', 'Briqueterie', 'Obili', 'Damas', 'Efoulan', 'Ahala', 'Nkoabang',
      'Olembe', 'Nkolmesseng', 'Mballa', 'Ekie', 'Simbock', 'Etoa-Meki', 'Messa', 'Mfandena', 'Nkomo', 'Mvolye']
  },
  { name: 'Mbalmayo', lat: 3.5150, lng: 11.5010 },
  { name: 'Obala', lat: 4.1680, lng: 11.5330 },
  { name: 'Ebolowa', lat: 2.9000, lng: 11.1500 },
  { name: 'Bertoua', lat: 4.5770, lng: 13.6840 },

  // North-West / West
  {
    name: 'Bamenda', lat: 5.9631, lng: 10.1591,
    areas: ['Nkwen', 'Up Station', 'Mankon', 'Ntarinkon', 'Old Town', 'Cow Street', 'Ntamulung', 'Bambui', 'Bambili',
      'Azire', 'Mulang', 'Musang', 'Foncha Street', 'Commercial Avenue', 'Ntahkah', 'Atuakom', 'Alakuma', 'Sisia',
      'Mile 4', 'Mile 3 Nkwen', 'Food Market', 'City Chemist', 'Hospital Roundabout', 'Ayaba', 'Below Foncha', 'Mbengwi Road']
  },
  { name: 'Kumbo', lat: 6.2000, lng: 10.6667 },
  { name: 'Ndop', lat: 6.0000, lng: 10.4200 },
  { name: 'Wum', lat: 6.3830, lng: 10.0670 },
  {
    name: 'Bafoussam', lat: 5.4778, lng: 10.4176,
    areas: ['Tamdja', 'Djeleng', 'Kouogouo', 'Banengo', 'Famla', 'Kamkop', 'Ndiengdam', 'Tyo', 'Tougang', 'Houkaha']
  },
  { name: 'Dschang', lat: 5.4500, lng: 10.0667 },
  { name: 'Mbouda', lat: 5.6260, lng: 10.2540 },
  { name: 'Bafang', lat: 5.1580, lng: 10.1830 },
  { name: 'Foumban', lat: 5.7270, lng: 10.9000 },

  // North
  { name: 'Ngaoundere', lat: 7.3270, lng: 13.5840 },
  { name: 'Garoua', lat: 9.3010, lng: 13.3980 },
  { name: 'Maroua', lat: 10.5910, lng: 14.3159 }
];
