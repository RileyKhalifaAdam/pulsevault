// Each call uses named fields. spec = file limits checked before upload; night = show safety reminder.
const CALLS=[
 {
  "id": "c1",
  "buyer": "Room Tone",
  "title": "A kitchen before anyone talks",
  "desc": "Morning, one room, natural light. Pour something, open a cabinet, leave. Do not talk to the camera. Upload the file.",
  "license": "AI training · Non-exclusive · 3 years",
  "tags": [
   "A room",
   "Sound"
  ],
  "city": "From anywhere",
  "pay": 90,
  "mount": "",
  "rating": 4.4,
  "ratings": 9,
  "dueH": 21,
  "slots": 5,
  "gear": "Phone only",
  "decision": "",
  "invite": false,
  "setting": "Indoor",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "vertical",
   "maxMB": 2000
  },
  "night": false
 },
 {
  "id": "c2",
  "buyer": "Keel Lab",
  "title": "A sidewalk at dusk, wherever you are",
  "desc": "Phone only. One block of a real sidewalk at dusk: people, a crossing, the sound of the street. Any city. Do not travel for this.",
  "license": "Commercial · Non-exclusive · 1 year",
  "tags": [
   "Street",
   "First-person",
   "Sound"
  ],
  "city": "From anywhere",
  "pay": 110,
  "mount": "",
  "rating": 4.6,
  "ratings": 22,
  "dueH": 21,
  "slots": 12,
  "gear": "Phone only",
  "decision": "12h",
  "invite": false,
  "setting": "Outdoor",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "any",
   "maxMB": 2000
  },
  "night": true
 },
 {
  "id": "c3",
  "buyer": "Roadside",
  "title": "Roadside after dark",
  "desc": "Street scene from the curb: vendors, headlights, a crossing. Not a shop interior. One continuous file you already have, or one you shoot tonight.",
  "license": "Commercial · Non-exclusive · 1 year",
  "tags": [
   "Street",
   "First-person",
   "Sound"
  ],
  "city": "Accra",
  "pay": 140,
  "mount": "",
  "rating": 4.5,
  "ratings": 11,
  "dueH": 21,
  "slots": 6,
  "gear": "Phone only",
  "decision": "",
  "invite": false,
  "setting": "Night",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "any",
   "maxMB": 2000
  },
  "night": true
 },
 {
  "id": "c4",
  "buyer": "Harbor Pictures",
  "title": "Stall restock before the crowd",
  "desc": "Night market stall, not a kitchen. Hands unloading crates, lighting a burner, the alley behind the stall. One file, no talking to camera.",
  "license": "Commercial · Non-exclusive · 1 year",
  "tags": [
   "Hands at work",
   "Food",
   "Sound",
   "Hands"
  ],
  "city": "Medellín",
  "pay": 190,
  "mount": "",
  "rating": 4.8,
  "ratings": 40,
  "dueH": 20,
  "slots": 5,
  "gear": "Phone only",
  "decision": "24h",
  "invite": false,
  "setting": "Market",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "any",
   "maxMB": 2000
  },
  "night": true
 },
 {
  "id": "c5",
  "buyer": "Harbor Pictures",
  "title": "Night market, spoon to mouth",
  "desc": "One continuous first-person video of ordering and eating at a night market you actually use. No cuts, no music, face can stay out of frame.",
  "license": "AI training · Non-exclusive · 3 years",
  "tags": [
   "First-person",
   "Food",
   "Sound"
  ],
  "city": "Medellín",
  "pay": 380,
  "mount": "+$15 for a mount, paid same-day",
  "rating": 4.8,
  "ratings": 40,
  "dueH": 19,
  "slots": 4,
  "gear": "Phone only",
  "decision": "24h",
  "invite": false,
  "setting": "Market",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "any",
   "maxMB": 2000
  },
  "night": true
 },
 {
  "id": "c6",
  "buyer": "Northline",
  "title": "Packing an order on a table",
  "desc": "Hands packing a real order: box, tape, label. Your table is enough. Phone only. No travel.",
  "license": "Commercial · Non-exclusive · 1 year",
  "tags": [
   "Hands at work",
   "Hands"
  ],
  "city": "From anywhere",
  "pay": 130,
  "mount": "",
  "rating": 4.9,
  "ratings": 31,
  "dueH": 43,
  "slots": 10,
  "gear": "Phone only",
  "decision": "24h",
  "invite": false,
  "setting": "Indoor",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "vertical",
   "maxMB": 2000
  },
  "night": false
 },
 {
  "id": "c7",
  "buyer": "Field & Co",
  "title": "Shop door to the counter",
  "desc": "One shot from outside a small shop, through the door, stopping at the counter. Street, then the room. Upload the file as shot.",
  "license": "Commercial · Non-exclusive · 1 year",
  "tags": [
   "Street",
   "A room",
   "First-person",
   "Sound"
  ],
  "city": "From anywhere",
  "pay": 120,
  "mount": "+$10 for a mount, paid next-day",
  "rating": 4.2,
  "ratings": 6,
  "dueH": 42,
  "slots": 10,
  "gear": "Phone only",
  "decision": "",
  "invite": false,
  "setting": "Shop",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "any",
   "maxMB": 2000
  },
  "night": false
 },
 {
  "id": "c8",
  "buyer": "Alley Run",
  "title": "Alley handoff, two stops",
  "desc": "A real delivery handoff in a narrow street. Door, bag, next door. No face required. Night, outdoor, first-person.",
  "license": "Editorial · Non-exclusive · 1 year",
  "tags": [
   "First-person",
   "Street",
   "Sound"
  ],
  "city": "Osaka",
  "pay": 175,
  "mount": "+$12 for a mount, paid next-day",
  "rating": 4.7,
  "ratings": 28,
  "dueH": 41,
  "slots": 8,
  "gear": "Phone only",
  "decision": "24h",
  "invite": false,
  "setting": "Night",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "any",
   "maxMB": 2000
  },
  "night": true
 },
 {
  "id": "c9",
  "buyer": "Quai",
  "title": "Fish dock at first light",
  "desc": "Outdoor work, not a household chore. The dock, the crates, the hoses. Hands and the walk between boats. A mounted or very steady phone.",
  "license": "Commercial · Exclusive · 1 year",
  "tags": [
   "Hands at work",
   "Motion",
   "Sound",
   "Hands"
  ],
  "city": "Marseille",
  "pay": 310,
  "mount": "+$20 for a mount, paid next-day",
  "rating": 4.9,
  "ratings": 17,
  "dueH": 72,
  "slots": 3,
  "gear": "Mount required",
  "decision": "12h",
  "invite": true,
  "setting": "Day",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "landscape",
   "maxMB": 2000
  },
  "night": true
 },
 {
  "id": "c10",
  "buyer": "Keel Lab",
  "title": "Handlebar ride, start to stop",
  "desc": "First-person video from a bike or scooter on a real trip: the street, the stops, the handoff. Upload a file you already shot. No gauges, no overlays.",
  "license": "Commercial · Non-exclusive · 1 year",
  "tags": [
   "First-person",
   "Street",
   "Motion",
   "Sound"
  ],
  "city": "From anywhere",
  "pay": 150,
  "mount": "+$12 for a mount, paid next-day",
  "rating": 4.6,
  "ratings": 22,
  "dueH": 38,
  "slots": 8,
  "gear": "Phone only",
  "decision": "24h",
  "invite": false,
  "setting": "Transit",
  "spec": {
   "minSec": 20,
   "maxSec": 600,
   "orientation": "any",
   "maxMB": 2000
  },
  "night": false
 },
 {
  "id": "c11",
  "buyer": "Third Shift",
  "title": "Warehouse gate, third shift",
  "desc": "Non-household night work. The gate, the yard, a truck arriving. Steady picture, sound of the yard. Premium bar.",
  "license": "Editorial · Non-exclusive · 1 year",
  "tags": [
   "Motion",
   "Street",
   "Sound"
  ],
  "city": "Detroit",
  "pay": 280,
  "mount": "+$15 for a mount, paid next-day",
  "rating": 4.3,
  "ratings": 8,
  "dueH": 72,
  "slots": 4,
  "gear": "Mount required",
  "decision": "",
  "invite": false,
  "setting": "Night",
  "spec": {
   "minSec": 20,
   "maxSec": 300,
   "orientation": "landscape",
   "maxMB": 2000
  },
  "night": true
 },
 {
  "id": "c12",
  "buyer": "Harbor Pictures",
  "title": "Stairs or a switchback",
  "desc": "Camera moves with you up a long stair or trail. Just the picture and the sound of the place. Upload it when the walk is done.",
  "license": "Commercial · Non-exclusive · 1 year",
  "tags": [
   "Motion",
   "First-person",
   "Sound"
  ],
  "city": "From anywhere",
  "pay": 260,
  "mount": "+$15 for a mount, paid next-day",
  "rating": 4.7,
  "ratings": 18,
  "dueH": 48,
  "slots": 3,
  "gear": "Mount required",
  "decision": "24h",
  "invite": false,
  "setting": "Outdoor",
  "spec": {
   "minSec": 20,
   "maxSec": 600,
   "orientation": "landscape",
   "maxMB": 2000
  },
  "night": false
 },
 {
  "id": "c13",
  "buyer": "Northline",
  "title": "Hands on a repeated task",
  "desc": "Hands doing the same job for a few minutes: packing, cooking, repair, a register. They want the motion, not a face. Upload the video.",
  "license": "Commercial · Non-exclusive · 1 year",
  "tags": [
   "Hands at work",
   "Hands"
  ],
  "city": "From anywhere",
  "pay": 220,
  "mount": "",
  "rating": 4.9,
  "ratings": 31,
  "dueH": 45,
  "slots": 6,
  "gear": "Phone only",
  "decision": "24h",
  "invite": false,
  "setting": "Transit",
  "spec": {
   "minSec": 20,
   "maxSec": 600,
   "orientation": "vertical",
   "maxMB": 2000
  },
  "night": false
 }
];
