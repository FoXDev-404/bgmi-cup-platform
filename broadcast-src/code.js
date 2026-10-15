// BGMI Premium Squad Dashboard — editable Figma design generator
// Run via Figma Desktop: Plugins > Development > Import plugin from manifest...
// All elements are native editable Figma layers (frames, shapes, and text).

const C = {
  bg: "#07131C",
  panel: "#0D1B25",
  panel2: "#101F2B",
  panel3: "#0A1721",
  border: "#2A4150",
  border2: "#476274",
  text: "#F3F7FA",
  muted: "#AABAC8",
  lime: "#A8FF00",
  limeDark: "#235400",
  yellow: "#FFD900",
  red: "#F52235",
  redDark: "#3A1119",
  orange: "#FFB51B",
  black: "#071019"
};

const hex = h => ({r:parseInt(h.slice(1,3),16)/255,g:parseInt(h.slice(3,5),16)/255,b:parseInt(h.slice(5,7),16)/255});
const solid = h => [{type:"SOLID", color:hex(h)}];

function rect(parent, name, x, y, w, h, fill, stroke=null, radius=12, sw=1) {
  const n = figma.createRectangle();
  n.name = name; n.x=x; n.y=y; n.resize(w,h);
  n.fills = fill ? solid(fill) : [];
  n.strokes = stroke ? solid(stroke) : [];
  n.strokeWeight = sw;
  n.cornerRadius = radius;
  parent.appendChild(n);
  return n;
}
function frame(parent, name, x,y,w,h, fill, stroke=null, radius=12) {
  const n=figma.createFrame();
  n.name=name; n.x=x; n.y=y; n.resize(w,h);
  n.fills=fill?solid(fill):[];
  n.strokes=stroke?solid(stroke):[];
  n.strokeWeight=1.5; n.cornerRadius=radius;
  n.clipsContent=false;
  parent.appendChild(n);
  return n;
}
async function txt(parent, name, value, x,y,w,h,size,color,weight="Medium",align="LEFT") {
  const n=figma.createText();
  n.name=name;
  n.fontName={family:"Inter",style:weight};
  n.characters=value;
  n.fontSize=size;
  n.fills=solid(color);
  n.textAlignHorizontal=align;
  n.textAlignVertical="CENTER";
  n.x=x;n.y=y;n.resize(w,h);
  parent.appendChild(n);
  return n;
}
function line(parent,name,x,y,w,color=C.border,thickness=1) {
  const n=figma.createRectangle(); n.name=name; n.x=x;n.y=y;n.resize(w,thickness);n.fills=solid(color);n.strokes=[];parent.appendChild(n);return n;
}
function pill(parent,name,label,x,y,w,h,bg,stroke,color,size=13) {
  const p=frame(parent,name,x,y,w,h,bg,stroke,h/2);
  p.strokeWeight=1.5;
  // frame children are local to the frame
  const dot=figma.createEllipse(); dot.name="Status dot"; dot.x=12;dot.y=(h-10)/2;dot.resize(10,10);dot.fills=solid(C.lime);dot.strokes=[];p.appendChild(dot);
  awaitText(p,label,28,0,w-34,h,size,color,"Bold","LEFT");
  return p;
}
function awaitText(parent,label,x,y,w,h,size,color,weight,align) {
  const n=figma.createText();
  n.name=label; n.fontName={family:"Inter",style:weight}; n.characters=label;
  n.fontSize=size;n.fills=solid(color);n.textAlignHorizontal=align;n.textAlignVertical="CENTER";
  n.x=x;n.y=y;n.resize(w,h);parent.appendChild(n);return n;
}
function button(parent,name,label,x,y,w,h,style="dark",size=14) {
  let bg=C.panel2, stroke=C.border2, color=C.text;
  if(style==="lime"){bg=C.limeDark;stroke=C.lime;color=C.text;}
  if(style==="yellow"){bg="#29260A";stroke=C.yellow;color=C.yellow;}
  if(style==="red"){bg=C.redDark;stroke=C.red;color=C.text;}
  const b=frame(parent,name,x,y,w,h,bg,stroke,Math.min(12,h/3));b.strokeWeight=1.6;
  awaitText(b,label,5,0,w-10,h,size,color,"Bold","CENTER");
  return b;
}
function stat(parent,label,value,x,y,w) {
  awaitText(parent,label.toUpperCase(),x,y,w,20,12,C.muted,"Bold","LEFT");
  awaitText(parent,value,x,y+21,w,32,24,C.text,"Bold","LEFT");
}
function playerCard(parent, idx, name, uid, x, y, w, h, status="ALIVE") {
  const card=frame(parent,`Player ${String(idx).padStart(2,"0")} — ${name}`,x,y,w,h,C.panel,C.border,18);
  card.strokeWeight=1.5;
  // Avatar
  const av=frame(card,"Player avatar",16,45,52,52,C.panel3,C.border2,12);av.strokeWeight=1.5;
  awaitText(av,"G",0,0,52,52,22,C.text,"Bold","CENTER");
  awaitText(card,`PLAYER ${String(idx).padStart(2,"0")}`,88,16,140,20,12,C.muted,"Bold","LEFT");
  awaitText(card,"Player IGN",name,88,37,w-185,30,18,C.text,"Bold","LEFT");
  awaitText(card,"Player UID",`UID ${uid}`,88,67,w-105,22,12,C.muted,"Medium","LEFT");
  const fin=frame(card,"Finish count badge",w-112,16,96,36,C.panel2,C.border2,18);
  const dot=figma.createEllipse();dot.name="Green status dot";dot.x=12;dot.y=13;dot.resize(10,10);dot.fills=solid(C.lime);fin.appendChild(dot);
  awaitText(fin,"0 FIN",30,0,58,36,13,C.text,"Bold","LEFT");
  line(card,"Player section divider",16,112,w-32,C.border,1);
  awaitText(card,"Damage label","DMG",16,124,44,38,12,C.text,"Bold","LEFT");
  const dmg=frame(card,"Damage value",60,124,76,38,C.panel3,C.border2,10);
  awaitText(dmg,"Damage value 0","0",0,0,76,38,18,C.text,"Bold","CENTER");
  button(card,"Decrease damage","−",144,124,48,38,"dark",20);
  button(card,"Add finish","+ FINISH",200,124,w-216,38,"lime",13);
  const statY=174, statH=48, gap=8, innerW=w-32, each=(innerW-gap*2)/3;
  button(card,"Status Alive","ALIVE",16,statY,each,statH,status==="ALIVE"?"lime":"dark",12);
  button(card,"Status Knock","KNOCK",16+each+gap,statY,each,statH,status==="KNOCK"?"yellow":"dark",12);
  button(card,"Status Eliminated","ELIM",16+(each+gap)*2,statY,each,statH,status==="ELIM"?"red":"dark",12);
  return card;
}

(async()=>{
  await figma.loadFontAsync({family:"Inter",style:"Regular"});
  await figma.loadFontAsync({family:"Inter",style:"Medium"});
  await figma.loadFontAsync({family:"Inter",style:"Bold"});

  const root=figma.createFrame();
  root.name="BGMI Broadcast — Premium Squad Layout";
  root.resize(1024,1365);
  root.fills=solid(C.bg);
  root.clipsContent=true;
  figma.currentPage.appendChild(root);

  // Subtle background edge
  rect(root,"Top ambient accent",24,24,976,3,C.yellow,null,2);

  // Squad overview panel
  const squad=frame(root,"Squad Overview",24,48,976,408,C.panel,C.border,22);
  squad.strokeWeight=1.5;
  // Header row
  frame(squad,"Squad number",22,24,78,78,C.panel3,C.border2,16);
  awaitText(squad,"Squad number 01","01",22,24,78,78,28,C.text,"Bold","CENTER");
  frame(squad,"Team emblem",132,24,78,78,C.panel2,C.border2,16);
  awaitText(squad,"Team emblem G","G",132,24,78,78,28,C.text,"Bold","CENTER");
  awaitText(squad,"Squad group","SQUAD #01  ·  GROUP A",242,22,430,22,15,C.muted,"Bold","LEFT");
  awaitText(squad,"Team name","GODL",242,47,430,42,32,C.text,"Bold","LEFT");
  line(squad,"Match points separator",730,22,1,C.border,90);
  awaitText(squad,"Match points label","MATCH PTS",756,24,132,22,14,C.muted,"Bold","LEFT");
  awaitText(squad,"Match points value","8",824,46,62,54,44,C.yellow,"Bold","RIGHT");
  button(squad,"Squad options","⌄",906,24,48,78,"dark",22);
  line(squad,"Header divider",0,128,976,C.border,1.5);

  // Stats row
  line(squad,"Stat separator 1",366,129,1,C.border,120);
  line(squad,"Stat separator 2",670,129,1,C.border,120);
  stat(squad,"Finishes","8",36,148,270);
  stat(squad,"Placement","—",396,148,240);
  stat(squad,"Place Pts","+0",700,148,240);
  line(squad,"Stats toolbar divider",0,249,976,C.border,1.5);

  // Squad actions toolbar
  button(squad,"Add squad finish","+ FINISH",22,272,202,76,"lime",18);
  button(squad,"Decrease squad finish","−",242,272,92,76,"dark",25);
  const place=frame(squad,"Placement control",354,272,238,76,C.panel2,C.border2,14);
  awaitText(place,"Placement label","PLACE",18,0,90,76,15,C.text,"Bold","CENTER");
  frame(place,"Placement value box",118,10,102,56,C.panel3,C.border2,10);
  awaitText(place,"Placement value","0",118,10,102,56,20,C.text,"Bold","CENTER");
  button(squad,"Auto scoring","AUTO",610,282,100,56,"yellow",15);
  button(squad,"Edit scoring","⚙  Edit Scoring",738,272,216,76,"dark",15);

  // Four compact player cards
  playerCard(root,1,"GODL9power","5324177447",24,476,476,378,"ALIVE");
  playerCard(root,2,"GODLManya","5246992569",524,476,476,378,"ALIVE");
  playerCard(root,3,"GODLADMINO","6425933398",24,876,476,378,"ALIVE");
  playerCard(root,4,"GODLNAKUL","6682980610",524,876,476,378,"ALIVE");

  // Footer note / safe bottom margin
  line(root,"Footer separator",0,1328,1024,C.border,1);
  awaitText(root,"Footer label","BGMI BROADCAST  /  OPERATOR VIEW",24,1334,500,20,10,C.muted,"Bold","LEFT");

  figma.currentPage.selection=[root];
  figma.viewport.scrollAndZoomIntoView([root]);
  figma.notify("Premium BGMI squad layout created. All elements are editable.");
  figma.closePlugin();
})();
