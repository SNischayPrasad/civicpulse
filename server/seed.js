/**
 * Seeds departments, demo accounts and the open-contracts registry.
 * Runs automatically on first boot; re-run manually with `npm run seed`.
 */
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import config from './config.js';
import db, { flushAll } from './db.js';
import { DEPARTMENTS } from './services/ai/taxonomy.js';

const hash = (pw) => bcrypt.hashSync(pw, 8);

export const DEMO_ACCOUNTS = [
  { name: 'Ananya Rao',       email: 'citizen@demo.in',            password: 'Citizen@123', role: 'citizen',    phone: '+91-98450-11111' },
  { name: 'Rahul Verma',      email: 'citizen2@demo.in',           password: 'Citizen@123', role: 'citizen',    phone: '+91-98450-22222' },
  { name: 'Suresh Kumar',     email: 'worker.roads@city.gov.in',   password: 'Worker@123',  role: 'worker',     departmentId: 'dept_roads',  employeeId: 'BBMP-RD-4471' },
  { name: 'Lakshmi Devi',     email: 'worker.sanit@city.gov.in',   password: 'Worker@123',  role: 'worker',     departmentId: 'dept_sanit',  employeeId: 'BBMP-SW-2210' },
  { name: 'Imran Shaikh',     email: 'worker.water@city.gov.in',   password: 'Worker@123',  role: 'worker',     departmentId: 'dept_water',  employeeId: 'BWSSB-9013' },
  { name: 'Deepak Nair',      email: 'worker.power@city.gov.in',   password: 'Worker@123',  role: 'worker',     departmentId: 'dept_power',  employeeId: 'BESCOM-3388' },
  { name: 'Meera Iyer',       email: 'supervisor.roads@city.gov.in', password: 'Super@123', role: 'supervisor', departmentId: 'dept_roads',  employeeId: 'BBMP-EE-102' },
  { name: 'Vikram Singh',     email: 'supervisor.sanit@city.gov.in', password: 'Super@123', role: 'supervisor', departmentId: 'dept_sanit',  employeeId: 'BBMP-EE-118' },
  { name: 'Control Room',     email: 'admin@city.gov.in',          password: 'Admin@123',   role: 'admin' }
];

/**
 * Open-contracts registry.
 * Field shape mirrors public works disclosures (work order, licence, DLP) so a
 * real deployment can ingest a municipal CSV/API without changing the schema.
 */
const CONTRACTORS = [
  {
    id: 'con_srinivasa', name: 'Srinivasa Infra Works Pvt Ltd', agency: 'BBMP Road Infrastructure Wing',
    licenceNo: 'KA/CL-I/2019/04412', workOrderNo: 'BBMP/RD/2025-26/0871',
    workType: 'Road asphalt resurfacing', workDescription: 'Asphalting and road resurfacing of ward arterial roads including kerb and footpath restoration',
    ward: 'KORAMANGALA', wardAliases: ['KORAMANGALA-3-BLOCK', 'KORAMANGALA-5-BLOCK'],
    location: { lat: 12.9352, lng: 77.6245 }, workRadiusM: 1500,
    contractValue: 48200000, currency: 'INR', startDate: '2025-06-15', endDate: '2026-03-31',
    defectLiabilityUntil: '2027-03-31', contact: 'srinivasa.infra@example.in / +91-80-4111-2201',
    rating: 3.4, activeContracts: 4, blacklisted: false,
    source: 'Municipal open-contracts disclosure', sourceUrl: 'https://bbmp.gov.in/tenders'
  },
  {
    id: 'con_greenearth', name: 'Green Earth Sanitation Services', agency: 'BBMP Solid Waste Management',
    licenceNo: 'KA/SWM/2021/00981', workOrderNo: 'BBMP/SWM/2025-26/0233',
    workType: 'Solid waste collection and sanitation', workDescription: 'Door-to-door waste collection, black spot clearing and street cleaning for the ward',
    ward: 'INDIRANAGAR', wardAliases: ['INDIRA-NAGAR'],
    location: { lat: 12.9719, lng: 77.6412 }, workRadiusM: 2000,
    contractValue: 22750000, currency: 'INR', startDate: '2025-04-01', endDate: '2027-03-31',
    defectLiabilityUntil: '2027-09-30', contact: 'ops@greenearth.example.in / +91-80-4111-8890',
    rating: 4.1, activeContracts: 2, blacklisted: false,
    source: 'Municipal open-contracts disclosure', sourceUrl: 'https://bbmp.gov.in/tenders'
  },
  {
    id: 'con_aquapipe', name: 'AquaPipe Engineering Co.', agency: 'BWSSB Pipeline Division',
    licenceNo: 'KA/WS/2020/07734', workOrderNo: 'BWSSB/PL/2025-26/0119',
    workType: 'Water pipeline and sewerage laying', workDescription: 'Laying of 300mm water pipeline, sewer line rehabilitation and manhole chamber construction',
    ward: 'JAYANAGAR', wardAliases: ['JAYANAGAR-4-BLOCK', 'JAYA-NAGAR'],
    location: { lat: 12.9250, lng: 77.5938 }, workRadiusM: 1800,
    contractValue: 91500000, currency: 'INR', startDate: '2024-11-01', endDate: '2026-06-30',
    defectLiabilityUntil: '2028-06-30', contact: 'projects@aquapipe.example.in / +91-80-4111-5522',
    rating: 2.8, activeContracts: 6, blacklisted: false,
    source: 'State eProcurement portal', sourceUrl: 'https://eproc.karnataka.gov.in'
  },
  {
    id: 'con_voltline', name: 'VoltLine Electricals', agency: 'BESCOM Street Lighting Cell',
    licenceNo: 'KA/EL/2022/03310', workOrderNo: 'BESCOM/SL/2025-26/0442',
    workType: 'Street lighting electrical maintenance', workDescription: 'LED street light installation, pole erection and electrical fault maintenance',
    ward: 'HSR-LAYOUT', wardAliases: ['HSR', 'HSR-SECTOR-2'],
    location: { lat: 12.9116, lng: 77.6389 }, workRadiusM: 2500,
    contractValue: 15600000, currency: 'INR', startDate: '2025-08-01', endDate: '2026-07-31',
    defectLiabilityUntil: '2027-07-31', contact: 'support@voltline.example.in / +91-80-4111-7744',
    rating: 3.9, activeContracts: 3, blacklisted: false,
    source: 'Municipal open-contracts disclosure', sourceUrl: 'https://bescom.karnataka.gov.in'
  },
  {
    id: 'con_shakti', name: 'Shakti Constructions', agency: 'BBMP Civil Works',
    licenceNo: 'KA/CL-II/2018/01187', workOrderNo: 'BBMP/CW/2024-25/0655',
    workType: 'Civil construction, footpath and drain', workDescription: 'Storm water drain construction, footpath paver work and civil restoration',
    ward: 'WHITEFIELD', wardAliases: ['WHITE-FIELD'],
    location: { lat: 12.9698, lng: 77.7500 }, workRadiusM: 3000,
    contractValue: 63400000, currency: 'INR', startDate: '2024-02-01', endDate: '2025-08-31',
    defectLiabilityUntil: '2026-08-31', contact: 'admin@shakticon.example.in / +91-80-4111-3366',
    rating: 2.2, activeContracts: 1, blacklisted: true, blacklistReason: 'Repeated DLP defect notices - 11 recurring potholes on completed stretches',
    source: 'Municipal open-contracts disclosure', sourceUrl: 'https://bbmp.gov.in/tenders'
  },
  {
    id: 'con_urbanleaf', name: 'UrbanLeaf Horticulture LLP', agency: 'BBMP Horticulture Wing',
    licenceNo: 'KA/HT/2023/00520', workOrderNo: 'BBMP/HT/2025-26/0087',
    workType: 'Horticulture, tree maintenance and landscaping', workDescription: 'Tree trimming, park maintenance, avenue plantation and green waste clearance',
    ward: 'KORAMANGALA', wardAliases: ['KORAMANGALA-5-BLOCK', 'EJIPURA'],
    location: { lat: 12.9310, lng: 77.6280 }, workRadiusM: 2200,
    contractValue: 8900000, currency: 'INR', startDate: '2025-05-01', endDate: '2027-04-30',
    defectLiabilityUntil: '2027-10-31', contact: 'care@urbanleaf.example.in / +91-80-4111-9911',
    rating: 4.4, activeContracts: 2, blacklisted: false,
    source: 'Municipal open-contracts disclosure', sourceUrl: 'https://bbmp.gov.in/tenders'
  }
];

export function seedDepartments() {
  for (const d of DEPARTMENTS) {
    if (!db.departments.byId(d.id)) db.departments.insert({ ...d, active: true });
  }
}

export function seedContractors() {
  for (const c of CONTRACTORS) {
    if (!db.contractors.byId(c.id)) db.contractors.insert(c);
  }
}

export function seedUsers() {
  for (const a of DEMO_ACCOUNTS) {
    if (db.users.findOne({ email: a.email })) continue;
    const { password, ...rest } = a;
    db.users.insert({
      ...rest,
      passwordHash: hash(password),
      trustScore: a.role === 'citizen' ? 0.7 : 1,
      reportsFiled: 0,
      verifiedReports: 0,
      isDemo: true
    });
  }
}

export function ensureSeed() {
  seedDepartments();
  seedContractors();
  seedUsers();
  flushAll();
}

function wipe() {
  if (!fs.existsSync(config.paths.data)) return;
  for (const f of fs.readdirSync(config.paths.data)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(config.paths.data, f));
  }
  console.log('Wiped data/ - restart the server to reseed.');
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seed.js');
if (invokedDirectly) {
  if (process.argv.includes('--wipe')) {
    wipe();
  } else {
    ensureSeed();
    console.log('Seeded departments, contractors and demo accounts.');
    console.table(DEMO_ACCOUNTS.map(({ email, password, role }) => ({ email, password, role })));
  }
}

export default { ensureSeed, DEMO_ACCOUNTS };
