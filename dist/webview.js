import{a as wt,b as s,c as p}from"./chunks/chunk-GZY7JXL4.js";import{a as xt,b as Ct,c as D}from"./chunks/chunk-YFGDAPRZ.js";import{b as St,c as Ht,d as It,e as Rt,f as Pt,g as Ot,i as Ft,j as $t,k as Vt}from"./chunks/chunk-JD34IRIB.js";import{a as w}from"./chunks/chunk-RACRD5F3.js";import{A as Tt,B as Mt,C as At,D as kt,E as Nt,H as Me,I as Ae,M as Dt,N as Bt,b as it,d as rt,e as ot,f as st,g as ht,h as ft,j as x,k as oe,l as Te,n as h,o as gt,p as vt,q as bt,t as Et,u as yt,w as _,z as Lt}from"./chunks/chunk-BJAKTIEY.js";import"./chunks/chunk-U4GHJ2EV.js";import"./chunks/chunk-2NPC5QXW.js";import"./chunks/chunk-EW7M56MG.js";import"./chunks/chunk-XVD5IP7J.js";import"./chunks/chunk-SAFUR4L4.js";import"./chunks/chunk-M7SGBPCJ.js";import"./chunks/chunk-R6H2YBFN.js";import{A as ie,J as O,M as A,N as nt,ca as k,m as J,n as y,o as Z,q as Ze,r as ee,s as te,t as et,u as tt,z as ne}from"./chunks/chunk-NXEH5LOL.js";import"./chunks/chunk-AYUEJA5Y.js";import{A as ut,D as Le,F as pt,G as mt,p as xe,s as at,t as re,u as Ce,v as lt,x as dt,y as ct}from"./chunks/chunk-7YT265GX.js";import{i as Y,l as Qe,m as C,p as Je,r as Q}from"./chunks/chunk-6ZSA7TA4.js";import"./chunks/chunk-ZJ56L73P.js";var _t=new Set([".","\uFF0E","\u3002","\u30FB",":","\uFF1A","/","\uFF0F","-"]),Wt=new Set([".","\uFF0E","\u3001",")","\uFF09",":","\uFF1A","-"]),ke={"\u3007":0,\u96F6:0,\u4E00:1,\u4E8C:2,\u4E24:2,\u4E09:3,\u56DB:4,\u4E94:5,\u516D:6,\u4E03:7,\u516B:8,\u4E5D:9};var Ne=999,W=9312,zt=9331,z=12832,Ut=12841,B=8544,L=8560;function Ie(t){let e=[],n=t.split(`
`),i=!1,r=0;for(let o=0;o<n.length;o+=1){let a=n[o],l=a.endsWith("\r")?a.slice(0,-1):a;if(l.match(/^ {0,3}(`{3,}|~{3,})/)){i=!i,r+=a.length+1;continue}if(!i){let c=l.match(/^( {0,3})(#{1,6})([ \t]+)(.*)$/);if(c){let u=r+c[1].length+c[2].length+c[3].length;c[4].trim()!==""&&e.push({level:c[2].length,contentFrom:u})}else{let u=o+1<n.length&&n[o+1].endsWith("\r")?n[o+1].slice(0,-1):n[o+1],m=u!==void 0&&l.trim()!==""?u.match(/^ {0,3}(=+|-+)[ \t]*$/):null,g=l.match(/^ */)?.[0].length??0;m&&g<=3&&e.push({level:m[1][0]==="="?1:2,contentFrom:r+g})}}r+=a.length+1}return e}function Kt(t){let e=0,n=0,i=!1;for(let r of t)if(r in ke)n=ke[r],i=!0;else if(r==="\u5341"||r==="\u767E"||r==="\u5343"||r==="\u4E07")e+=(n||1)*(r==="\u5341"?10:r==="\u767E"?100:r==="\u5343"?1e3:1e4),n=0,i=!0;else return null;return e+=n,i&&e>=1&&e<=9999?e:null}function qt(t,e){if(!(e?/^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/:/^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/).test(t))return null;let i=e?{I:1,V:5,X:10,L:50,C:100,D:500,M:1e3}:{i:1,v:5,x:10,l:50,c:100,d:500,m:1e3},r=0;for(let o=0;o<t.length;o+=1){let a=i[t[o]],l=i[t[o+1]]??0;r+=a<l?-a:a}return r>=1&&r<=4999?r:null}function Gt(t,e){let n=t[e];if(n===void 0)return null;let i=n.codePointAt(0)??0;if(/^[０-９]+/.test(t.slice(e))){let d=t.slice(e).match(/^[０-９]+/)?.[0]??"",c=Number.parseInt(Array.from(d).map(u=>String.fromCodePoint((u.codePointAt(0)??0)-65248)).join(""),10);if(c>=1&&c<=Ne)return{type:"fullwidth",value:c,length:d.length}}if(i>=z&&i<=Ut)return{type:"circledCn",value:i-z+1,length:1};if(i>=W&&i<=zt)return{type:"circled",value:i-W+1,length:1};if(i>=B&&i<=B+11||i>=L&&i<=L+11)return{type:i>=L?"romanUnicodeLower":"romanUnicodeUpper",value:(i>=L?i-L:i-B)+1,length:1};let r=t.slice(e).match(/^[0-9]+/)?.[0];if(r){let d=Number.parseInt(r,10);if(d>=1&&d<=Ne)return{type:"arabic",value:d,length:r.length}}let o=t.slice(e).match(/^[〇零一二三四五六七八九十百千万两]+/)?.[0];if(o){let d=Kt(o);if(d!==null)return{type:"chinese",value:d,length:o.length}}let a=t.slice(e).match(/^[IVXLCDM]+/)?.[0];if(a){let d=qt(a,!0);if(d!==null)return{type:"romanUpper",value:d,length:a.length}}let l=t.slice(e).match(/^[ivxlcdm]+/)?.[0];if(l){let d=qt(l,!1);if(d!==null)return{type:"romanLower",value:d,length:l.length}}return/^[A-Z]/.test(n)?{type:"latinUpper",value:i-64,length:1}:/^[a-z]/.test(n)?{type:"latinLower",value:i-96,length:1}:null}function jt(t,e){let n=Gt(t,e);if(!n)return null;let i=[n],r=[],o=e+n.length;for(;o<t.length&&_t.has(t[o]);){let a=t[o],l=Gt(t,o+1);if(!l)break;r.push(a),i.push(l),o+=1+l.length}return{atoms:i,separators:r,pos:o}}function di(t,e){return e>=t.length||t[e]===" "||t[e]==="	"}function He(t,e,n){if(di(t,e))return!0;if(!n)return!1;let i=t.codePointAt(e);return i!==void 0&&i>127}function U(t){let e=t.match(/^第([0-9]+|[〇零一二三四五六七八九十百千万两]+)([章节部分篇条款项回])/);if(e){let i=e[1],r=/^[0-9]+$/.test(i)?Number.parseInt(i,10):Kt(i),o=e[0].length;if(r!==null&&r>=1&&He(t,o,!0))return{format:{open:"\u7B2C",segments:[/^[0-9]+$/.test(i)?"arabic":"chinese"],separators:[],close:e[2],spaceAfter:t[o]===" "||t[o]==="	"},length:o}}if(t[0]==="\uFF08"||t[0]==="("){let i=t[0],r=i==="\uFF08"?"\uFF09":")",o=jt(t,1);if(o&&t[o.pos]===r&&He(t,o.pos+1,!0))return{format:{open:i,segments:o.atoms.map(a=>a.type),separators:o.separators,close:r,spaceAfter:t[o.pos+1]===" "||t[o.pos+1]==="	"},length:o.pos+1}}let n=jt(t,0);if(n&&n.atoms.length>0){let i="",r=n.pos;if(r<t.length&&Wt.has(t[r])&&(i=t[r],r+=1),He(t,r,i!==""))return{format:{open:"",segments:n.atoms.map(o=>o.type),separators:n.separators,close:i,spaceAfter:t[r]===" "||t[r]==="	"},length:r}}return null}function Xt(t){let e=["\u3007","\u4E00","\u4E8C","\u4E09","\u56DB","\u4E94","\u516D","\u4E03","\u516B","\u4E5D"],n=l=>{if(l<10)return e[l];if(l===10)return"\u5341";if(l<20)return`\u5341${e[l-10]}`;let d=Math.floor(l/10),c=l%10;return`${e[d]}\u5341${c>0?e[c]:""}`};if(t<100)return n(t);let i=[],r=Math.floor(t/1e3),o=Math.floor(t%1e3/100),a=t%100;return r>0&&i.push(`${e[r]}\u5343`),o>0?i.push(`${e[o]}\u767E`):i.length>0&&a>0&&i.push("\u96F6"),a>0&&(a<10&&i[i.length-1]!=="\u96F6"&&i.push("\u96F6"),i.push(n(a))),i.join("")}function Yt(t,e){let n=e?65:97,i=t,r="";for(;i>0;)i-=1,r=String.fromCodePoint(n+i%26)+r,i=Math.floor(i/26);return r}function se(t,e){let n=[[1e3,"M","m"],[900,"CM","cm"],[500,"D","d"],[400,"CD","cd"],[100,"C","c"],[90,"XC","xc"],[50,"L","l"],[40,"XL","xl"],[10,"X","x"],[9,"IX","ix"],[5,"V","v"],[4,"IV","iv"],[1,"I","i"]],i=t,r="";for(let[o,a,l]of n)for(;i>=o;)r+=e?a:l,i-=o;return r}function ci(t,e){switch(t){case"arabic":return String(e);case"fullwidth":return Array.from(String(e),n=>String.fromCodePoint((n.codePointAt(0)??0)+65248)).join("");case"chinese":return Xt(Math.min(e,9999));case"latinUpper":return Yt(e,!0);case"latinLower":return Yt(e,!1);case"romanUpper":return se(e,!0);case"romanLower":return se(e,!1);case"romanUnicodeUpper":return e>=1&&e<=12?String.fromCodePoint(B+e-1):se(e,!0);case"romanUnicodeLower":return e>=1&&e<=12?String.fromCodePoint(L+e-1):se(e,!1);case"circled":return e>=1&&e<=20?String.fromCodePoint(W+e-1):String(e);case"circledCn":return e>=1&&e<=10?String.fromCodePoint(z+e-1):Xt(e)}}var ui={open:"",segments:["arabic"],separators:[],close:"",spaceAfter:!0};function Qt(t,e,n){let i=t.segments[t.segments.length-1],r=t.separators[t.separators.length-1]??".",o=[];for(let l=0;l<n;l+=1){let d=l<t.segments.length?t.segments[l]:i;o.push(ci(d,e[l+1]))}let a=o[0];for(let l=1;l<n;l+=1){let d=l-1<t.separators.length?t.separators[l-1]:r;a+=d+o[l]}return`${t.open}${a}${t.close}`}function Jt(t){if(t.length===0)return[];let e=Math.min(...t.map(r=>r.level)),n=[],i=0;for(let r of t){let o=r.level-e+1,a=Math.min(o,i+1);n.push(a),i=a}return n}function Zt(t,e){for(let n of e){let i=t.indexOf(`
`,n.contentFrom);i===-1&&(i=t.length);let r=t.slice(n.contentFrom,i).replace(/\r$/,""),o=U(r);if(o)return o.format}return ui}function en(t){let e=Ie(t);if(e.length===0)return[];let n=Zt(t,e),i=Jt(e),r=[0],o=[];for(let a=0;a<e.length;a+=1){let l=e[a],d=i[a];r[d]=(r[d]??0)+1;for(let b=d+1;b<r.length;b+=1)r[b]=0;let c=t.indexOf(`
`,l.contentFrom);c===-1&&(c=t.length);let u=t.slice(l.contentFrom,c).replace(/\r$/,""),m=Qt(n,r,d),g=n.spaceAfter?" ":"",E=U(u);if(E){let b=u.slice(E.length).match(/^[ \t]+/)?.[0].length??0,M=E.length+b,Se=u.slice(M).length>0?`${m}${g}`:m;o.push({from:l.contentFrom,to:l.contentFrom+M,insert:Se})}else{let b=u?`${m}${g}`:m;o.push({from:l.contentFrom,to:l.contentFrom,insert:b})}}return o}function tn(t){let e=Ie(t),n=[];for(let i of e){let r=t.indexOf(`
`,i.contentFrom);r===-1&&(r=t.length);let o=t.slice(i.contentFrom,r).replace(/\r$/,""),a=U(o);if(!a)continue;let l=o.slice(a.length).match(/^[ \t]+/)?.[0].length??0;n.push({from:i.contentFrom,to:i.contentFrom+a.length+l,insert:""})}return n}var Re=["rgba(235, 131, 131, 0.5)","rgba(174, 154, 203, 0.5)","rgba(125, 181, 205, 0.5)","rgba(113, 167, 150, 0.5)","rgba(220, 191, 97, 0.5)","rgba(221, 163, 106, 0.5)"];function nn(t){let e=t.split(/\r?\n/),n=[],i=[],r=new Map,o=!1,a="",l=0;for(let d=0;d<e.length;d+=1){let c=e[d],u=c.match(/^\s{0,3}(```+|~~~+)/);if(u){let b=u[1][0],M=u[1].length;o?b===a&&M>=l&&(o=!1,a="",l=0):(o=!0,a=b,l=M);continue}if(o)continue;let m=c.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);if(m){ae(n,i,r,m[1].length,le(m[2]),d+1);continue}let g=e[d+1],E=g&&/^\s*=+\s*$/.test(g)?1:g&&/^\s*-+\s*$/.test(g)?2:0;if(E>0){let b=le(c);b&&ae(n,i,r,E,b,d+1),d+=1}}return n}function ae(t,e,n,i,r,o){if(!r)return;for(;e.length>0&&e[e.length-1].level>=i;)e.pop();let l=`${e.map(u=>u.id).join("/")}|${i}`,d=(n.get(l)??0)+1;n.set(l,d);let c={id:`${l}|${d}|${o}`,level:i,text:r,line:o,children:[]};e.length===0?t.push(c):e[e.length-1].children.push(c),e.push(c)}function le(t){return t.replace(/<\/?[a-zA-Z][^>]*>/g,"").replace(/\s+#+\s*$/,"").replace(/\[(.*?)\]\((.*?)\)/g,"$1").replace(/[`*_~]/g,"").replace(/\s+/g," ").trim()}function rn(t){let e=t.contentEl.scrollTop,n=t.contentEl.scrollLeft;if(t.hideTooltip(),t.activeNodeId=t.findActiveNodeId(t.nodes,t.activeLine),t.nodes.length===0){t.contentEl.innerHTML='<div class="outline-empty">\u6807\u9898\u5927\u7EB2</div>',t.panelEl.classList.add("is-empty"),t.updateActionBarState(),t.restoreScrollPosition(e,n);return}t.panelEl.classList.remove("is-empty");let i=t.findActiveNodeId(t.nodes,t.activeLine),r=t.renderNodes(t.nodes,i);t.contentEl.innerHTML=`<div class="outline-tree" role="tree">${r}</div>`,t.updateActionBarState(),t.restoreScrollPosition(e,n)}function on(t,e,n){return e.map(i=>{let r=(i.level-1)%Re.length,o=Re[r],a=t.collapsedNodeIds.has(i.id),l=i.children.length>0,d=i.id===n,c=l?t.buildToggleIcon(a):"",u=t.buildIndentGuides(i.level),m=l&&!a?`<div class="outline-children">${t.renderNodes(i.children,n)}</div>`:"";return`
                <div
                    class="outline-item"
                    data-node-id="${t.escapeHtml(i.id)}"
                    data-level="${i.level}"
                    style="--outline-accent: ${o}; --outline-indent: ${Math.max(0,i.level-1)*8}px;"
                >
                    <div
                        class="outline-row"
                        data-outline-action="jump"
                        data-level="${i.level}"
                        data-line="${i.line}"
                        data-outline-title="${t.escapeHtml(i.text)}"
                        data-active="${d?"true":"false"}"
                        role="button"
                        tabindex="0"
                        aria-label="\u8DF3\u8F6C\u5230\u7B2C ${i.line} \u884C\uFF1A${t.escapeHtml(i.text)}"
                    >
                        <span
                            class="outline-toggle${l?"":" outline-toggle-spacer"}"
                            data-outline-action="toggle"
                            data-node-id="${i.id}"
                            data-collapsed="${a?"true":"false"}"
                            aria-hidden="true"
                        >${c}</span>
                        ${u}
                        <span class="outline-label">${t.escapeHtml(i.text)}</span>
                        <span class="outline-meta">${t.escapeHtml(t.metaLabel(i.line))}</span>
                    </div>
                    ${m}
                </div>
            `}).join("")}function sn(t,e,n){let i=null,r=o=>{for(let a of o)a.line<=n&&(i=a),a.children.length>0&&a.line<=n&&r(a.children)};return r(e),i?.id??null}function an(t){let e=t.findActiveNodeId(t.nodes,t.activeLine);if(t.activeNodeId===e||(t.activeNodeId&&t.contentEl.querySelector(`[data-node-id="${CSS.escape(t.activeNodeId)}"] > .outline-row`)?.setAttribute("data-active","false"),t.activeNodeId=e,!t.activeNodeId))return;let n=t.contentEl.querySelector(`[data-node-id="${CSS.escape(t.activeNodeId)}"] > .outline-row`);n?.setAttribute("data-active","true"),n?.scrollIntoView({block:"nearest",inline:"nearest"})}function ln(t,e){return`
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style="transform: rotate(${e?"0deg":"90deg"}); transform-origin: 50% 50%;">
            <path d="M5.5 3.5L10 8l-4.5 4.5-.7-.7L8.6 8 4.8 4.2z"></path>
        </svg>
    `}function dn(t,e){if(!h.getBoolean("outlineGuides"))return"";let n=Math.max(0,e-1);return n===0?"":`
        <span class="outline-guides" aria-hidden="true">
            ${Array.from({length:n},(i,r)=>`<span class="outline-guide${r===n-1?" is-last":""}"></span>`).join("")}
        </span>
    `}function cn(t){let e=t.panelEl.querySelector("#outline-actions");if(e)return e;let n=document.createElement("div");return n.id="outline-actions",n.className="outline-actions",t.panelEl.appendChild(n),n}function un(t,e,n){let i=t.panelEl.querySelector(`button[data-outline-action="${e}"]`);if(i)return i;let r=document.createElement("button");return r.type="button",r.className="outline-action-btn",r.setAttribute("data-outline-action",e),r.setAttribute("aria-label",n),r.setAttribute("title",n),r.innerHTML=`<span class="outline-action-icon" aria-hidden="true">${t.buildActionGlyph(e)}</span>`,t.actionBarEl.appendChild(r),r}function pn(t,e){if(e==="add-numbering"||e==="remove-numbering")return`
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                    <path d="M6 4h7.5M6 8h7.5M6 12h7.5"></path>
                    ${e==="remove-numbering"?'<path d="M2.2 14L13.8 2" stroke-width="1.5"></path>':""}
                </g>
                <g fill="currentColor" font-family="var(--vscode-editor-font-family, monospace)" font-size="4.6">
                    <text x="1.1" y="5.7">1</text>
                    <text x="1.1" y="9.7">2</text>
                    <text x="1.1" y="13.7">3</text>
                </g>
            </svg>
        `;let n={"collapse-all":"M3.5 8h9","expand-all":"M3.5 8h9M8 3.5v9"};return`
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="${n[e]??n["expand-all"]}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
        </svg>
    `}function mn(t){let e=t.panelEl.querySelector("#outline-tooltip");if(e)return e;let n=document.createElement("div");return n.id="outline-tooltip",n.className="outline-tooltip",n.setAttribute("role","tooltip"),n.setAttribute("aria-hidden","true"),t.panelEl.appendChild(n),n}function hn(t,e,n,i){let r=e.getAttribute("data-outline-title")?.trim()??"";r&&(t.cancelTooltipTimer(),t.hoveredRowEl=e,t.hoveredTitle=r,t.hoveredClientX=n,t.hoveredClientY=i,t.hoverTimer=window.setTimeout(()=>{t.hoveredRowEl===e&&t.showTooltip(e,r,n,i)},500))}function fn(t){t.hoverTimer!==null&&(window.clearTimeout(t.hoverTimer),t.hoverTimer=null)}function gn(t,e,n,i,r){t.tooltipEl.textContent=n,t.tooltipEl.dataset.visible="true",t.tooltipEl.setAttribute("aria-hidden","false"),t.tooltipEl.style.visibility="hidden",window.requestAnimationFrame(()=>{t.hoveredRowEl!==e||t.hoveredTitle!==n||(t.positionTooltip(i,r),t.tooltipEl.style.visibility="visible")})}function vn(t,e,n){let i=t.panelEl.getBoundingClientRect(),r=t.tooltipEl.getBoundingClientRect(),o=e-i.left,a=n-i.top,l=8,d=8,c=o-r.width-l,u=a+l;c=Math.max(d,Math.min(c,i.width-r.width-d)),u=Math.max(d,Math.min(u,i.height-r.height-d)),t.tooltipEl.style.left=`${c}px`,t.tooltipEl.style.top=`${u}px`,t.tooltipEl.dataset.placement="cursor"}function bn(t){t.cancelTooltipTimer(),t.hoveredRowEl=null,t.hoveredTitle="",t.tooltipEl.dataset.visible="false",t.tooltipEl.setAttribute("aria-hidden","true")}function En(t,e,n){t.contentEl.scrollTop=e,t.contentEl.scrollLeft=n,window.requestAnimationFrame(()=>{t.contentEl.scrollTop!==e&&(t.contentEl.scrollTop=e),t.contentEl.scrollLeft!==n&&(t.contentEl.scrollLeft=n)})}function yn(t){let e=t.nodes.length>0;t.expandAllButtonEl.disabled=!e,t.collapseAllButtonEl.disabled=!e;let n=!e||!t.isEditable();t.addNumberingButtonEl.disabled=n,t.removeNumberingButtonEl.disabled=n}function wn(t,e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function Sn(t){t.resizerEl.addEventListener("pointerdown",t.handleResizerPointerDown),t.contentEl.addEventListener("click",t.handleContentClick),t.contentEl.addEventListener("keydown",t.handleContentKeyDown),t.contentEl.addEventListener("pointerover",t.handleContentPointerOver),t.contentEl.addEventListener("pointerout",t.handleContentPointerOut),t.contentEl.addEventListener("scroll",t.handleContentScroll,{passive:!0}),t.actionBarEl.addEventListener("click",t.handleActionBarClick)}var de=class{panelEl;contentEl;resizerEl;actionBarEl;expandAllButtonEl;collapseAllButtonEl;addNumberingButtonEl;removeNumberingButtonEl;tooltipEl;onWidthChange;onNavigateToLine;isEditable;getDocument;onApplyHeadingEdits;width;outlineVisible=!0;nodes=[];activeNodeId=null;collapsedNodeIds=new Set;activeLine=1;metaProvider=null;dragging=!1;dragStartX=0;dragStartWidth=0;hoverTimer=null;hoveredRowEl=null;hoveredTitle="";hoveredClientX=0;hoveredClientY=0;constructor(e,n,i,r){this.panelEl=e,this.contentEl=n,this.resizerEl=i,this.onWidthChange=r.onWidthChange,this.onNavigateToLine=r.onNavigateToLine,this.isEditable=r.isEditable,this.getDocument=r.getDocument,this.onApplyHeadingEdits=r.onApplyHeadingEdits,this.width=this.clampWidth(r.initialWidth),this.actionBarEl=this.resolveActionBarElement(),this.expandAllButtonEl=this.resolveActionButton("expand-all","\u5C55\u5F00\u5168\u90E8"),this.collapseAllButtonEl=this.resolveActionButton("collapse-all","\u6536\u8D77\u5168\u90E8"),this.addNumberingButtonEl=this.resolveActionButton("add-numbering","\u6807\u9898\u7F16\u53F7"),this.removeNumberingButtonEl=this.resolveActionButton("remove-numbering","\u53D6\u6D88\u7F16\u53F7"),this.tooltipEl=this.resolveTooltipElement(),this.applyWidth(this.width),this.bindEvents(),this.updateActionBarState()}clampWidth(e){return Number.isFinite(e)?Math.min(520,Math.max(220,Math.round(e))):220}applyWidth(e){this.width=this.clampWidth(e),document.documentElement.style.setProperty("--livewritemd-outline-width",`${this.width}px`),this.panelEl.style.width=`${this.width}px`,this.panelEl.style.flexBasis=`${this.width}px`}handleResizerPointerDown=e=>{if(e.button!==0)return;e.preventDefault(),this.dragging=!0,this.dragStartX=e.clientX,this.dragStartWidth=this.width,this.resizerEl.dataset.dragging="true",document.body.classList.add("livewritemd-outline-resizing");let n=r=>{if(!this.dragging)return;let o=r.clientX-this.dragStartX;this.applyWidth(this.dragStartWidth-o)},i=r=>{this.dragging&&(this.dragging=!1,this.resizerEl.dataset.dragging="false",document.body.classList.remove("livewritemd-outline-resizing"),this.resizerEl.releasePointerCapture(r.pointerId),window.removeEventListener("pointermove",n),window.removeEventListener("pointerup",i),window.removeEventListener("pointercancel",i),this.onWidthChange(this.width))};this.resizerEl.setPointerCapture(e.pointerId),window.addEventListener("pointermove",n),window.addEventListener("pointerup",i),window.addEventListener("pointercancel",i)};handleContentClick=e=>{let n=e.target;if(!n)return;let i=n.closest('[data-outline-action="toggle"]');if(i){e.preventDefault(),e.stopPropagation();let l=i.getAttribute("data-node-id");l&&(this.collapsedNodeIds.has(l)?this.collapsedNodeIds.delete(l):this.collapsedNodeIds.add(l),this.render());return}let r=n.closest('[data-outline-action="jump"]');if(!r)return;let o=r.getAttribute("data-line"),a=Number.parseInt(o??"",10);Number.isFinite(a)&&this.onNavigateToLine(a)};handleContentKeyDown=e=>{let n=e.target;if(!n)return;let i=n.closest('[data-outline-action="jump"]');if(!i||e.key!=="Enter"&&e.key!==" ")return;e.preventDefault();let r=i.getAttribute("data-line"),o=Number.parseInt(r??"",10);Number.isFinite(o)&&this.onNavigateToLine(o)};handleContentPointerOver=e=>{let n=e.target;if(!n)return;let i=n.closest('[data-outline-action="jump"]');!i||i===this.hoveredRowEl||(this.hoveredClientX=e.clientX,this.hoveredClientY=e.clientY,this.scheduleTooltip(i,e.clientX,e.clientY))};handleContentPointerOut=e=>{let n=e.target;if(!n)return;let i=n.closest('[data-outline-action="jump"]'),r=e.relatedTarget;i&&r&&i.contains(r)||i&&i===this.hoveredRowEl&&this.hideTooltip()};handleContentScroll=()=>{this.hoveredRowEl&&this.hideTooltip()};handleActionBarClick=e=>{let n=e.target;if(!n)return;let i=n.closest("[data-outline-action]");if(!i)return;let r=i.getAttribute("data-outline-action");if(r==="add-numbering"||r==="remove-numbering"){if(!this.isEditable())return;let o=this.getDocument(),a=r==="add-numbering"?en(o):tn(o);a.length>0&&this.onApplyHeadingEdits(a);return}r==="expand-all"?this.expandAll():r==="collapse-all"&&this.collapseAll()};parseHeadings(e){return nn(e)}pushHeadingNode(e,n,i,r,o,a){return ae(e,n,i,r,o,a)}normalizeHeadingText(e){return le(e)}render(){return rn(this)}renderNodes(e,n){return on(this,e,n)}findActiveNodeId(e,n){return sn(this,e,n)}syncActiveState(){return an(this)}buildToggleIcon(e){return ln(this,e)}buildIndentGuides(e){return dn(this,e)}resolveActionBarElement(){return cn(this)}resolveActionButton(e,n){return un(this,e,n)}buildActionGlyph(e){return pn(this,e)}resolveTooltipElement(){return mn(this)}scheduleTooltip(e,n,i){return hn(this,e,n,i)}cancelTooltipTimer(){return fn(this)}showTooltip(e,n,i,r){return gn(this,e,n,i,r)}positionTooltip(e,n){return vn(this,e,n)}hideTooltip(){return bn(this)}restoreScrollPosition(e,n){return En(this,e,n)}updateActionBarState(){return yn(this)}escapeHtml(e){return wn(this,e)}bindEvents(){return Sn(this)}setContent(e,n){Number.isFinite(n??NaN)&&(this.activeLine=Math.floor(n)),this.nodes=this.parseHeadings(e),this.render()}setMetaProvider(e){this.metaProvider=e,this.render()}refresh(){this.render()}metaLabel(e){let n=this.metaProvider?.(e);return n&&n.length>0?n:String(e)}updateContent(e,n){this.setContent(e,n)}setWidth(e){this.applyWidth(e)}setVisible(e){let n=!!e;if(this.outlineVisible!==n){if(this.outlineVisible=n,n){this.panelEl.hidden=!1,this.panelEl.style.display="",this.panelEl.style.visibility="",this.panelEl.style.width="",this.panelEl.style.flexBasis="",this.panelEl.setAttribute("aria-hidden","false"),this.resizerEl.hidden=!1,this.resizerEl.style.display="",this.resizerEl.style.visibility="",this.resizerEl.setAttribute("aria-hidden","false"),this.applyWidth(this.width);return}this.panelEl.hidden=!0,this.panelEl.setAttribute("aria-hidden","true"),this.panelEl.style.display="none",this.panelEl.style.visibility="hidden",this.panelEl.style.width="0",this.panelEl.style.flexBasis="0",this.resizerEl.hidden=!0,this.resizerEl.setAttribute("aria-hidden","true"),this.resizerEl.style.display="none",this.resizerEl.style.visibility="hidden"}}toggleVisible(){this.setVisible(!this.outlineVisible)}setActiveLine(e){!Number.isFinite(e)||e<1||(this.activeLine=Math.floor(e),this.syncActiveState())}getWidth(){return this.width}isOutlineVisible(){return this.outlineVisible}expandAll(){this.collapsedNodeIds.size!==0&&(this.collapsedNodeIds.clear(),this.render())}collapseAll(){let e=new Set,n=i=>{for(let r of i)r.children.length>0&&(e.add(r.id),n(r.children))};n(this.nodes),this.collapsedNodeIds.clear();for(let i of e)this.collapsedNodeIds.add(i);this.render()}};var Cn=`
#livewritemd-settings-root {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: none;
}
#livewritemd-settings-root[data-open="true"] { display: block; }

.fms-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    animation: fms-fade 0.16s ease;
}
@keyframes fms-fade { from { opacity: 0; } }

.fms-window {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(920px, 94vw);
    height: min(720px, 90vh);
    display: flex;
    flex-direction: column;
    background: var(--vscode-editorBackground, #252526);
    color: var(--vscode-editorForeground, #d4d4d4);
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
    border-radius: 10px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    animation: fms-pop 0.18s ease;
}
@keyframes fms-pop {
    from { opacity: 0; transform: translate(-50%, -48%); }
}

.fms-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.18));
    font-size: 15px;
    font-weight: 600;
}
.fms-header-title { flex: 1 1 auto; }
.fms-header-sub {
    font-size: 11px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground, #999);
    margin-right: 4px;
}
.fms-help {
    width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font-size: 12px;
    cursor: pointer;
}
.fms-help:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
.fms-close {
    width: 28px; height: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    border: none; border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 18px;
    cursor: pointer;
}
.fms-close:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }

.fms-body { flex: 1 1 auto; display: flex; min-height: 0; }

/* \u5E95\u90E8\u64CD\u4F5C\u680F\uFF1A\u5E94\u7528\u6309\u94AE\u56FA\u5B9A\u5728\u5DE6\u4E0B\u89D2 */
.fms-footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-top: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.18));
}
/* \u5E38\u9A7B\u8BF4\u660E\uFF1A\u544A\u8BC9\u65B0\u624B\u4E0D\u7528\u627E\u300C\u4FDD\u5B58\u300D\u6309\u94AE */
.fms-footer-note {
    flex: 1 1 auto;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
}
.fms-reset-all {
    padding: 4px 12px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #bbb);
    font-size: 11.5px;
    cursor: pointer;
}
.fms-reset-all:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
/* \u4E8C\u6B21\u786E\u8BA4\u6001\uFF1A\u53D8\u7EA2\u63D0\u9192\u300C\u8FD9\u4E00\u4E0B\u771F\u7684\u4F1A\u91CD\u7F6E\u5168\u90E8\u300D */
.fms-reset-all[data-armed="true"] {
    color: var(--vscode-errorForeground, #f48771);
    border-color: var(--vscode-errorForeground, #f48771);
    background: rgba(244, 135, 113, 0.12);
}
.fms-apply {
    padding: 5px 20px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    font-size: 12px;
    cursor: pointer;
}
.fms-apply:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.fms-apply:active { transform: translateY(1px); }
.fms-apply-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #999);
    opacity: 0;
    transition: opacity 0.15s ease;
}
.fms-apply-hint[data-show="true"] { opacity: 1; }

/* \u5DE6\u680F\uFF1A\u641C\u7D22\u6846\u56FA\u5B9A\u5728\u9876\u90E8\uFF0C\u5206\u7EC4\u5217\u8868\u81EA\u5DF1\u6EDA\u52A8 */
.fms-nav {
    flex: 0 0 186px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    padding: 10px 8px;
    border-right: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.14));
}
.fms-nav-list {
    flex: 1 1 auto;
    overflow-y: auto;
}
.fms-search {
    flex: 0 0 auto;
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    font-size: 12px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, inherit);
    outline: none;
}
.fms-search:focus { border-color: var(--vscode-focusBorder, #007acc); }
.fms-search::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
.fms-nav-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    margin-bottom: 2px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    font-size: 13px;
    cursor: pointer;
}
.fms-nav-btn:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
.fms-nav-btn[data-active="true"] {
    background: var(--vscode-list-activeSelectionBackground, rgba(79,193,255,0.25));
    color: var(--vscode-list-activeSelectionForeground, inherit);
}
.fms-nav-icon { width: 18px; text-align: center; }

/* \u4E8C\u7EA7\u5BFC\u822A\uFF1A\u7236\u5206\u7EC4\u53EF\u5C55\u5F00 / \u6536\u8D77\uFF0C\u5B50\u5206\u7EC4\u7F29\u8FDB\u663E\u793A */
.fms-nav-btn--parent { font-weight: 500; }
/* \u5F53\u524D\u9009\u4E2D\u9879\u5728\u5B83\u4E0B\u9762\u65F6\u7ED9\u4E00\u70B9\u5F31\u9AD8\u4EAE\uFF0C\u5E2E\u52A9\u4E00\u773C\u770B\u51FA\u5C42\u7EA7\u5F52\u5C5E */
.fms-nav-btn--parent[data-child-active="true"] {
    color: var(--vscode-list-activeSelectionForeground, inherit);
}
/* \u5C55\u5F00\u7BAD\u5934\uFF1A\u7528\u4F4D\u79FB\u8868\u793A\u72B6\u6001\uFF0C\u4E0D\u4F9D\u8D56\u989D\u5916\u7684\u5B57\u4F53\u56FE\u6807 */
.fms-nav-caret {
    margin-left: auto;
    font-size: 10px;
    opacity: 0.65;
    transition: transform 0.15s ease;
}
.fms-nav-btn--parent[data-expanded="false"] .fms-nav-caret {
    transform: rotate(-90deg);
}
/* \u5B50\u9879\u5217\u8868\uFF1A\u5DE6\u4FA7\u4E00\u6761\u7EC6\u5F15\u5BFC\u7EBF + \u7F29\u8FDB\uFF0C\u6CBF\u7528\u73B0\u6709\u914D\u8272\u53D8\u91CF */
.fms-nav-children {
    margin: 0 0 2px;
    padding-left: 6px;
    border-left: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.2));
    margin-left: 17px;
}
.fms-nav-children[data-expanded="false"] { display: none; }
.fms-nav-btn--child {
    padding: 6px 8px 6px 10px;
    font-size: 12.5px;
}
.fms-nav-btn--child .fms-nav-icon {
    width: 16px;
    font-size: 12px;
}

.fms-content {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px 22px 28px;
}

.fms-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 13px 2px;
    border-bottom: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.1));
}
.fms-info { flex: 1 1 auto; min-width: 0; }
.fms-label { font-size: 13px; font-weight: 500; }
.fms-desc { margin-top: 3px; font-size: 11.5px; color: var(--vscode-descriptionForeground, #999); line-height: 1.5; }
.fms-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }

/* toggle switch */
.fms-switch {
    position: relative;
    width: 38px; height: 20px;
    border-radius: 999px;
    background: rgba(128,128,128,0.35);
    border: none;
    cursor: pointer;
    transition: background 0.15s ease;
}
.fms-switch::after {
    content: "";
    position: absolute;
    top: 2px; left: 2px;
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
}
.fms-switch[data-on="true"] { background: var(--vscode-button-background, #0e639c); }
.fms-switch[data-on="true"]::after { transform: translateX(18px); }

/* slider */
.fms-slider { width: 150px; accent-color: var(--vscode-focusBorder, #007acc); }
.fms-slider-value {
    min-width: 52px;
    text-align: right;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #aaa);
}

/* color */
.fms-color {
    width: 32px; height: 24px;
    padding: 0;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 5px;
    background: none;
    cursor: pointer;
}
.fms-color::-webkit-color-swatch-wrapper { padding: 2px; }
.fms-color::-webkit-color-swatch { border: none; border-radius: 3px; }
.fms-color-text {
    width: 78px;
    font-size: 11px;
    padding: 3px 6px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: inherit;
}
.fms-reset {
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #bbb);
    font-size: 11px;
    padding: 3px 8px;
    cursor: pointer;
}
.fms-reset:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
.fms-auto-tag {
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground, #999);
}

/* \u5B57\u4F53\u9009\u62E9\uFF1A\u8F93\u5165\u6846 + datalist + \u300C\u8DDF\u968F\u300D\u6309\u94AE */
.fms-font {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}
.fms-font .fms-text {
    flex: 1;
    min-width: 190px;
}

/* select / text */
.fms-select, .fms-text {
    min-width: 200px;
    font-size: 12px;
    padding: 5px 8px;
    border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: var(--vscode-dropdown-background, #3c3c3c);
    color: var(--vscode-dropdown-foreground, inherit);
}
.fms-text {
    background: var(--vscode-input-background, #3c3c3c);
    border-color: var(--vscode-input-border, rgba(128,128,128,0.3));
}
/* \u5206\u7EC4\u6807\u9898 + \u4E00\u53E5\u8BDD\u8BF4\u660E */
.fms-section-head { margin: 14px 2px 2px; }
.fms-section-head:first-child { margin-top: 4px; }
.fms-section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--vscode-editorForeground, inherit);
}
.fms-section-desc {
    margin-top: 4px;
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--vscode-descriptionForeground, #999);
}

/* \u65B0\u624B\u5F15\u5BFC\u5361\u7247 */
.fms-guide {
    margin: 6px 0 14px;
    padding: 12px 14px;
    border: 1px solid var(--vscode-focusBorder, rgba(0,122,204,0.55));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, rgba(79,193,255,0.07));
}
.fms-guide-head {
    display: flex;
    align-items: center;
    gap: 8px;
}
.fms-guide-title {
    flex: 1 1 auto;
    font-size: 13px;
    font-weight: 600;
}
.fms-guide-close {
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground, #999);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
}
.fms-guide-close:hover { color: var(--vscode-editorForeground, inherit); }
.fms-guide-steps {
    margin: 8px 0 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.65;
    color: var(--vscode-editorForeground, inherit);
}
.fms-guide-steps li { margin-bottom: 4px; }
.fms-guide-tip {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed var(--vscode-editorGroup-border, rgba(128,128,128,0.2));
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--vscode-descriptionForeground, #999);
}

/* \u5DF2\u6539\u52A8\u6807\u8BB0 / \u884C\u5C3E\u6062\u590D\u9ED8\u8BA4 / \u641C\u7D22\u91CC\u7684\u5206\u7EC4\u6807\u7B7E */
.fms-mod-badge {
    display: none;
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 400;
    color: var(--vscode-focusBorder, #4fc1ff);
    background: rgba(79, 193, 255, 0.15);
}
.fms-row[data-modified="true"] .fms-mod-badge { display: inline-block; }
.fms-row-reset {
    flex: 0 0 auto;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #bbb);
    font-size: 10.5px;
    padding: 3px 8px;
    cursor: pointer;
    white-space: nowrap;
}
.fms-row-reset:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
.fms-row-chip {
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #999);
    font-size: 10.5px;
    font-weight: 400;
    cursor: pointer;
}
.fms-row-chip:hover {
    color: var(--vscode-editorForeground, inherit);
    border-color: var(--vscode-focusBorder, #007acc);
}
/* \u4ECE\u641C\u7D22\u8DF3\u56DE\u5206\u7EC4\u65F6\uFF0C\u76EE\u6807\u884C\u95EA\u4E00\u4E0B\uFF0C\u5E2E\u52A9\u773C\u775B\u5B9A\u4F4D */
.fms-row[data-flash="true"] { animation: fms-flash 1.2s ease; }
@keyframes fms-flash {
    0% { background: rgba(79, 193, 255, 0.22); }
    100% { background: transparent; }
}

/* \u641C\u7D22\u65E0\u7ED3\u679C */
.fms-empty {
    padding: 28px 8px;
    font-size: 12.5px;
    line-height: 1.8;
    text-align: center;
    color: var(--vscode-descriptionForeground, #999);
}
`;function Ln(t){let e=t.trim();if(/^#[0-9a-fA-F]{6}$/.test(e))return e;if(/^#[0-9a-fA-F]{3}$/.test(e))return"#"+e.slice(1).split("").map(o=>o+o).join("");let n=document.createElement("span");n.style.color=e,document.body.appendChild(n);let i=getComputedStyle(n).color;n.remove();let r=i.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);return r?"#"+[r[1],r[2],r[3]].map(o=>Number(o).toString(16).padStart(2,"0")).join(""):"#888888"}var hi={h1Color:".cm-md-heading-1",h2Color:".cm-md-heading-2",h3Color:".cm-md-heading-3",h4Color:".cm-md-heading-4",h5Color:".cm-md-heading-5",h6Color:".cm-md-heading-6",boldColor:".cm-md-bold",italicColor:".cm-md-italic",strikethroughColor:".cm-md-strikethrough",inlineCodeColor:".cm-md-code",inlineCodeBackground:".cm-md-code",codeblockBackground:".cm-md-codeblock",codeblockEdge:".cm-md-codeblock",linkColor:".cm-md-link",quoteBorderColor:".cm-md-blockquote",quoteTextColor:".cm-md-blockquote",hrColor:".cm-md-hr",tableBorderColor:".cm-md-tcell",tableHeaderBackground:".cm-md-table-header .cm-md-tcell",tableStripeBackground:".cm-md-tcell",tableSelectedBackground:".cm-md-tcell-selected",bulletColor:".cm-md-bullet",checkboxAccent:".cm-md-checkbox"},fi=new Set(["inlineCodeBackground","codeblockBackground","tableHeaderBackground","tableStripeBackground"]);function Tn(t){let e=hi[t];if(!e)return null;let n=document.querySelector(e);if(!n)return null;let i=getComputedStyle(n),o=(fi.has(t)?i.backgroundColor:i.color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);return o?"#"+[o[1],o[2],o[3]].map(a=>Number(a).toString(16).padStart(2,"0")).join(""):null}function gi(t,e){let n=document.createElement("button");n.className="fms-switch",n.type="button";let i=()=>n.setAttribute("data-on",String(h.getBoolean(t.key)));return i(),n.addEventListener("click",()=>{e.commit(!h.getBoolean(t.key)),i()}),n}function vi(t,e){let n=document.createElement("div");n.style.display="flex",n.style.alignItems="center",n.style.gap="8px";let i=document.createElement("input");i.type="range",i.className="fms-slider",i.min=String(t.min??0),i.max=String(t.max??100),i.step=String(t.step??1),i.value=String(h.getNumber(t.key));let r=document.createElement("span");r.className="fms-slider-value";let o=()=>{let l=h.getNumber(t.key),d=t.valueLabels?.find(u=>u.value===l);if(d)return d.label;let c=(String(t.step??1).split(".")[1]??"").length;return`${l.toFixed(c)}${t.unit??""}`},a=()=>{r.textContent=o()};return a(),i.addEventListener("input",()=>{e.commit(Number(i.value)),a()}),n.appendChild(i),n.appendChild(r),n}function bi(t,e){let n=document.createElement("div");n.style.display="flex",n.style.alignItems="center",n.style.gap="6px";let i=document.createElement("input");i.type="color",i.className="fms-color";let r=document.createElement("input");r.type="text",r.className="fms-color-text",r.spellcheck=!1;let o=document.createElement("span");o.className="fms-auto-tag";let a=document.createElement("button");a.type="button",a.className="fms-reset",a.textContent="\u91CD\u7F6E";let l=()=>h.getString(t.key),d=()=>l().trim()==="",c=()=>{if(d())i.value=Tn(t.key)??"#888888",r.value="\u81EA\u52A8",o.textContent="\u8DDF\u968F\u4E3B\u9898",a.style.display="none";else{let u=Ln(l());i.value=u,r.value=l(),o.textContent="",a.style.display=""}};return i.addEventListener("input",()=>{e.commit(i.value),c()}),r.addEventListener("change",()=>{let u=r.value.trim();u===""||u==="\u81EA\u52A8"?e.commit(""):e.commit(u),c()}),a.addEventListener("click",()=>{e.commit(""),c()}),c(),n.appendChild(i),n.appendChild(r),n.appendChild(o),n.appendChild(a),n}var Pe=[];function Mn(t){Pe=t}var ue=new Set,S=new Map;function ce(t,e){for(let n of e){let i=document.createElement("option");i.value=n,t.appendChild(i)}}function Ei(t,e){if(t.innerHTML="",Pe.length>0){ce(t,Pe);return}let n=(e??[]).map(i=>i.value).filter(i=>i.length>0);ce(t,n)}function yi(t,e){let n=document.createElement("div");n.className="fms-font";let i=document.createElement("input");i.type="text",i.className="fms-text",i.value=h.getString(t.key),i.placeholder=t.placeholder??"\u8F93\u5165\u5B57\u4F53\u540D\u7B5B\u9009\uFF0C\u6216\u5C55\u5F00\u5217\u8868\u9009\u62E9",i.spellcheck=!1;let r=`fms-font-list-${t.key}`;i.setAttribute("list",r);let o=document.createElement("datalist");o.id=r,Ei(o,t.options),ue.add(o),i.addEventListener("input",()=>{let l=i.value.trim();S.set(t.key,l),h.set(t.key,l)}),i.addEventListener("change",()=>{S.delete(t.key),e.commit(i.value.trim())});let a=document.createElement("button");return a.type="button",a.className="fms-reset",a.textContent="\u8DDF\u968F",a.title="\u6E05\u7A7A\uFF0C\u6539\u7528\u9ED8\u8BA4\u5B57\u4F53",a.addEventListener("click",()=>{i.value="",S.delete(t.key),e.commit("")}),n.appendChild(i),n.appendChild(o),n.appendChild(a),n}function wi(t,e){let n=document.createElement("select");n.className="fms-select";for(let i of t.options??[]){let r=document.createElement("option");r.value=i.value,r.textContent=i.label,n.appendChild(r)}return n.value=h.getString(t.key)||String(t.default),n.addEventListener("change",()=>e.commit(n.value)),n}function Si(t,e){let n=document.createElement("input");return n.type="text",n.className="fms-text",n.value=h.getString(t.key),t.placeholder&&(n.placeholder=t.placeholder),n.addEventListener("input",()=>{S.set(t.key,n.value),h.set(t.key,n.value)}),n.addEventListener("change",()=>{S.delete(t.key),e.commit(n.value)}),n}function An(t,e){switch(t.control){case"toggle":return gi(t,e);case"slider":return vi(t,e);case"color":return bi(t,e);case"select":return wi(t,e);case"text":return Si(t,e);case"font":return yi(t,e);default:return document.createElement("span")}}var kn="livewritemd.settingsGuideDismissed",Nn=new Set(["color","font"]),Oe=class{root;navEl;contentEl;searchEl;resetAllBtn;applyHint;activeSection=x[0].id;expandedParents=new Set;query="";onChange=null;applyHintTimer=null;resetAllArmed=!1;resetAllTimer=null;guideForced=!1;constructor(){let e=document.createElement("style");e.textContent=Cn,document.head.appendChild(e),this.root=document.createElement("div"),this.root.id="livewritemd-settings-root",this.root.innerHTML=`
            <div class="fms-overlay"></div>
            <div class="fms-window" role="dialog" aria-modal="true" aria-label="LiveWriteMD \u8BBE\u7F6E" tabindex="-1">
                <div class="fms-header">
                    <span class="fms-header-title">LiveWriteMD \u8BBE\u7F6E</span>
                    <span class="fms-header-sub">\u6539\u52A8\u5373\u65F6\u9884\u89C8\uFF0C\u81EA\u52A8\u4FDD\u5B58</span>
                    <button class="fms-help" type="button" title="\u4F7F\u7528\u8BF4\u660E">?</button>
                    <button class="fms-close" type="button" aria-label="\u5173\u95ED">\u2715</button>
                </div>
                <div class="fms-body">
                    <div class="fms-nav">
                        <input class="fms-search" type="search" spellcheck="false"
                            placeholder="\u641C\u7D22\u8BBE\u7F6E\u2026" aria-label="\u641C\u7D22\u8BBE\u7F6E" />
                        <div class="fms-nav-list"></div>
                    </div>
                    <div class="fms-content"></div>
                </div>
                <div class="fms-footer">
                    <button class="fms-apply" type="button">\u5E94\u7528</button>
                    <span class="fms-apply-hint"></span>
                    <span class="fms-footer-note">\u5F00\u5173 / \u6ED1\u6746 / \u989C\u8272\u5373\u65F6\u751F\u6548\uFF1B\u6587\u672C\u6846\u56DE\u8F66\u6216\u5931\u7126\u4FDD\u5B58</span>
                    <button class="fms-reset-all" type="button" title="\u628A\u6240\u6709\u8BBE\u7F6E\u6062\u590D\u4E3A\u9ED8\u8BA4\u503C">\u5168\u90E8\u6062\u590D\u9ED8\u8BA4</button>
                </div>
            </div>
        `,document.body.appendChild(this.root),this.navEl=this.root.querySelector(".fms-nav-list"),this.contentEl=this.root.querySelector(".fms-content"),this.searchEl=this.root.querySelector(".fms-search"),this.resetAllBtn=this.root.querySelector(".fms-reset-all"),this.applyHint=this.root.querySelector(".fms-apply-hint"),this.root.querySelector(".fms-apply").addEventListener("click",()=>{this.applyPending(),this.showHint("\u5DF2\u5E94\u7528")}),this.resetAllBtn.addEventListener("click",()=>this.handleResetAll()),this.root.querySelector(".fms-help").addEventListener("click",()=>{this.guideForced=!0,this.activeSection=x[0].id,this.clearSearch(),this.syncNavActive(),this.buildContent()}),this.searchEl.addEventListener("input",()=>{let i=this.searchEl.value.trim();i!==this.query&&(this.query=i,this.buildContent())}),this.searchEl.addEventListener("keydown",i=>{i.key!=="Escape"||!this.searchEl.value||(i.preventDefault(),i.stopPropagation(),this.clearSearch(),this.buildContent(),this.searchEl.focus())}),this.root.addEventListener("keydown",i=>{if(i.key!=="/"||i.ctrlKey||i.metaKey||i.altKey)return;let r=i.target?.tagName;r==="INPUT"||r==="TEXTAREA"||r==="SELECT"||(i.preventDefault(),this.searchEl.focus())}),this.root.querySelector(".fms-close").addEventListener("click",()=>this.close()),this.root.querySelector(".fms-overlay").addEventListener("click",()=>this.close()),this.root.addEventListener("keydown",i=>{i.key==="Escape"&&this.close()});for(let i of x)(i.children?.length??0)>0&&this.expandedParents.add(i.id);this.buildNav()}registerChangeHandler(e){this.onChange=e}buildNav(){for(let e of x){if((e.children?.length??0)===0){this.navEl.appendChild(this.buildNavButton(e,!1));continue}let n=document.createElement("div");n.className="fms-nav-group";let i=document.createElement("button");i.type="button",i.className="fms-nav-btn fms-nav-btn--parent",i.dataset.parentId=e.id,i.title=e.description??e.label,i.innerHTML=`
                <span class="fms-nav-icon">${e.icon}</span>
                <span class="fms-nav-label">${e.label}</span>
                <span class="fms-nav-caret" aria-hidden="true">\u25BE</span>
            `,i.addEventListener("click",()=>this.toggleParent(e));let r=document.createElement("div");r.className="fms-nav-children",r.dataset.childrenOf=e.id;for(let o of e.children??[])r.appendChild(this.buildNavButton(o,!0));n.appendChild(i),n.appendChild(r),this.navEl.appendChild(n)}this.syncNavActive()}buildNavButton(e,n){let i=document.createElement("button");return i.type="button",i.className=`fms-nav-btn${n?" fms-nav-btn--child":""}`,i.dataset.sectionId=e.id,i.innerHTML=`<span class="fms-nav-icon">${e.icon}</span><span class="fms-nav-label">${e.label}</span>`,i.title=e.description??e.label,i.addEventListener("click",()=>{this.activeSection=e.id,this.clearSearch(),this.expandAncestors(e.id),this.syncNavActive(),this.buildContent()}),i}leafIdsOf(e){let n=[];for(let i of e.children??[])(i.children?.length??0)>0?n.push(...this.leafIdsOf(i)):n.push(i.id);return n}expandAncestors(e){for(let n of x)(n.children?.length??0)!==0&&this.leafIdsOf(n).includes(e)&&this.expandedParents.add(n.id)}toggleParent(e){let n=this.query!=="",i=!this.expandedParents.has(e.id),r=!1;if(i){this.expandedParents.add(e.id);let o=this.leafIdsOf(e);!o.includes(this.activeSection)&&o.length>0&&(this.activeSection=o[0],r=!0)}else this.expandedParents.delete(e.id);n&&(this.clearSearch(),r=!0),r&&this.buildContent(),this.syncNavActive()}syncNavActive(){for(let e of this.navEl.querySelectorAll("[data-section-id]"))e.setAttribute("data-active",String(e.dataset.sectionId===this.activeSection));for(let e of this.navEl.querySelectorAll(".fms-nav-btn--parent")){let n=e.dataset.parentId??"",i=x.find(r=>r.id===n);e.setAttribute("data-expanded",String(this.expandedParents.has(n))),e.setAttribute("data-child-active",String(i?this.leafIdsOf(i).includes(this.activeSection):!1))}for(let e of this.navEl.querySelectorAll(".fms-nav-children")){let n=e.dataset.childrenOf??"";e.setAttribute("data-expanded",String(this.expandedParents.has(n)))}}parentLabelOf(e){for(let n of x)if((n.children?.length??0)!==0&&this.leafIdsOf(n).includes(e))return n.label}clearSearch(){this.query="",this.searchEl.value=""}buildContent(){if(this.contentEl.scrollTop=0,this.contentEl.innerHTML="",ue.clear(),this.query){this.buildSearchResults();return}let e=oe.find(n=>n.id===this.activeSection)??oe[0];if(e.id===x[0].id){let n=this.buildGuide();n&&this.contentEl.appendChild(n)}this.contentEl.appendChild(this.buildSectionHead(e));for(let n of e.items??[])n.hidden||this.contentEl.appendChild(this.buildRow(n))}buildSectionHead(e){let n=document.createElement("div");n.className="fms-section-head";let i=document.createElement("div");if(i.className="fms-section-title",i.textContent=`${e.icon} ${e.label}`,n.appendChild(i),e.description){let r=document.createElement("div");r.className="fms-section-desc",r.textContent=e.description,n.appendChild(r)}return n}buildGuide(){if(!(this.guideForced||(()=>{try{return localStorage.getItem(kn)!=="1"}catch{return!0}})()))return null;let n=document.createElement("div");return n.className="fms-guide",n.innerHTML=`
            <div class="fms-guide-head">
                <span class="fms-guide-title">\u{1F44B} \u7B2C\u4E00\u6B21\u7528\uFF1F\u6309\u8FD9\u4E09\u6B65\u8C03</span>
                <button class="fms-guide-close" type="button" title="\u6536\u8D77\u5F15\u5BFC">\xD7</button>
            </div>
            <ol class="fms-guide-steps">
                <li><b>\u5DE6\u8FB9\u9009\u5206\u7EC4</b>\uFF1A\u6309\u7528\u9014\u5206\u597D\u4E86\uFF08\u7F16\u8F91\u5668 / \u6807\u9898\u4E0E\u6587\u5B57 / \u8868\u683C / \u601D\u7EF4\u5BFC\u56FE\u2026\uFF09\uFF0C
                    \u6BCF\u4E2A\u5206\u7EC4\u6807\u9898\u4E0B\u90FD\u5199\u4E86\u5B83\u5F71\u54CD\u4EC0\u4E48\u3002</li>
                <li><b>\u53F3\u8FB9\u76F4\u63A5\u6539</b>\uFF1A\u5F00\u5173\u70B9\u4E00\u4E0B\uFF1B\u6ED1\u6746\u5DE6\u53F3\u62D6\uFF1B\u989C\u8272\u70B9\u8272\u5757\uFF0C
                    <b>\u7559\u7A7A\u6216\u70B9\u300C\u91CD\u7F6E\u300D\u4E00\u822C\u8868\u793A\u8DDF\u968F\u4E3B\u9898</b>\uFF08\u4E2A\u522B\u9879\u662F\u300C\u4E0D\u663E\u793A\u300D\uFF0C\u89C1\u8BE5\u9879\u8BF4\u660E\uFF09\uFF1B
                    \u5B57\u4F53\u6846\u8F93\u5165\u51E0\u4E2A\u5B57\u6BCD\u5C31\u4F1A\u7B5B\u9009\u3002</li>
                <li><b>\u4E0D\u7528\u624B\u52A8\u4FDD\u5B58</b>\uFF1A\u5F00\u5173 / \u6ED1\u6746 / \u989C\u8272\u7ACB\u523B\u751F\u6548\uFF1B\u6587\u672C\u6846\u548C\u5B57\u4F53\u6846\u6309\u56DE\u8F66\u6216\u70B9\u7A7A\u767D\u5904\u751F\u6548\u3002
                    \u6539\u52A8\u4F1A\u5199\u8FDB VS Code \u7528\u6237\u8BBE\u7F6E\uFF0C\u4E0B\u6B21\u6253\u5F00\u4ECD\u7136\u4FDD\u7559\u3002</li>
            </ol>
            <div class="fms-guide-tip">
                \u6539\u574F\u4E86\uFF1F\u628A\u9F20\u6807\u79FB\u5230\u8BBE\u7F6E\u9879\u4E0A\uFF0C\u884C\u5C3E\u4F1A\u51FA\u73B0\u300C\u6062\u590D\u9ED8\u8BA4\u300D\uFF1B\u4E5F\u53EF\u4EE5\u70B9\u5E95\u90E8\u300C\u5168\u90E8\u6062\u590D\u9ED8\u8BA4\u300D\u3002
                \u627E\u4E0D\u5230\u67D0\u9879\uFF1F\u5728\u5DE6\u4E0A\u89D2\u641C\u7D22\u6846\u8F93\u5165\u5173\u952E\u8BCD\uFF08\u8BD5\u8BD5\u300C\u5B57\u4F53\u300D\u300C\u884C\u8DDD\u300D\u300C\u8868\u683C\u300D\u300C\u5BFC\u56FE\u300D\uFF09\u3002
            </div>
        `,n.querySelector(".fms-guide-close").addEventListener("click",()=>{this.guideForced=!1;try{localStorage.setItem(kn,"1")}catch{}this.buildContent()}),n}buildSearchResults(){let e=this.query.toLowerCase(),n=[];for(let r of oe){let o=this.parentLabelOf(r.id);for(let a of r.items??[]){if(a.hidden)continue;[a.label,a.description,a.key,r.label,o].filter(Boolean).join(`
`).toLowerCase().includes(e)&&n.push({section:r,item:a})}}let i=document.createElement("div");if(i.className="fms-section-head",i.innerHTML=`
            <div class="fms-section-title">\u{1F50D} \u641C\u7D22\u7ED3\u679C</div>
            <div class="fms-section-desc">\u5339\u914D\u300C${xi(this.query)}\u300D\u7684\u8BBE\u7F6E ${n.length} \u9879</div>
        `,this.contentEl.appendChild(i),n.length===0){let r=document.createElement("div");r.className="fms-empty",r.innerHTML="\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u8BBE\u7F6E\u3002<br>\u8BD5\u8BD5\u66F4\u77ED\u7684\u5173\u952E\u8BCD\uFF0C\u4F8B\u5982\u300C\u5B57\u4F53\u300D\u300C\u884C\u8DDD\u300D\u300C\u989C\u8272\u300D\u300C\u5BFC\u56FE\u300D\u3002",this.contentEl.appendChild(r);return}for(let{section:r,item:o}of n)this.contentEl.appendChild(this.buildRow(o,r))}buildRow(e,n){let i=document.createElement("div");i.className="fms-row",i.dataset.key=e.key;let r=document.createElement("div");r.className="fms-info";let o=document.createElement("div");if(o.className="fms-label",n){let u=document.createElement("button");u.type="button",u.className="fms-row-chip",u.textContent=n.label,u.title=`\u524D\u5F80\u300C${n.label}\u300D\u5206\u7EC4`,u.addEventListener("click",()=>this.revealItem(n.id,e.key)),o.appendChild(u)}o.appendChild(document.createTextNode(e.label));let a=document.createElement("span");if(a.className="fms-mod-badge",a.textContent="\u5DF2\u6539\u52A8",o.appendChild(a),r.appendChild(o),e.description){let u=document.createElement("div");u.className="fms-desc",u.textContent=e.description,r.appendChild(u)}let l=An(e,{commit:u=>{this.commitItem(e.key,u),this.syncRowState(i,e)}}),d=document.createElement("div");d.className="fms-control",d.appendChild(l);let c=document.createElement("button");return c.type="button",c.className="fms-row-reset",c.textContent="\u6062\u590D\u9ED8\u8BA4",c.title=`\u6062\u590D\u4E3A\u9ED8\u8BA4\u503C\uFF1A${String(e.default)===""?"\u8DDF\u968F\u4E3B\u9898":String(e.default)}`,Nn.has(e.control)&&(c.style.display="none"),c.addEventListener("click",()=>this.resetItem(e)),i.appendChild(r),i.appendChild(d),i.appendChild(c),this.syncRowState(i,e),i}syncRowState(e,n){let i=!this.isDefault(n);if(e.setAttribute("data-modified",String(i)),!Nn.has(n.control)){let r=e.querySelector(".fms-row-reset");r&&(r.style.display=i?"":"none")}}isDefault(e){let n=h.get(e.key);return typeof e.default=="number"?Number(n)===e.default:String(n??"")===String(e.default)}commitItem(e,n){h.set(e,n),this.onChange?.(e,n)}resetItem(e){S.delete(e.key),this.commitItem(e.key,e.default);let n=this.contentEl.scrollTop;this.buildContent(),this.contentEl.scrollTop=n,this.showHint("\u5DF2\u6062\u590D\u9ED8\u8BA4")}handleResetAll(){if(!this.resetAllArmed){this.resetAllArmed=!0,this.resetAllBtn.textContent="\u518D\u70B9\u4E00\u6B21\u786E\u8BA4",this.resetAllBtn.setAttribute("data-armed","true"),this.resetAllTimer!==null&&window.clearTimeout(this.resetAllTimer),this.resetAllTimer=window.setTimeout(()=>this.disarmResetAll(),4e3);return}this.disarmResetAll(),S.clear();for(let e of Te)this.commitItem(e.key,e.default);h.reapplyAll(),this.buildContent(),this.showHint("\u5DF2\u6062\u590D\u5168\u90E8\u9ED8\u8BA4\u503C")}disarmResetAll(){this.resetAllTimer!==null&&(window.clearTimeout(this.resetAllTimer),this.resetAllTimer=null),this.resetAllArmed=!1,this.resetAllBtn.textContent="\u5168\u90E8\u6062\u590D\u9ED8\u8BA4",this.resetAllBtn.removeAttribute("data-armed")}revealItem(e,n){this.activeSection=e,this.clearSearch(),this.expandAncestors(e),this.syncNavActive(),this.buildContent();let i=this.contentEl.querySelector(`.fms-row[data-key="${n}"]`);i&&(i.scrollIntoView({block:"center"}),i.setAttribute("data-flash","true"),window.setTimeout(()=>i.removeAttribute("data-flash"),1200))}showHint(e){this.applyHint.textContent=e,this.applyHint.setAttribute("data-show","true"),this.applyHintTimer!==null&&window.clearTimeout(this.applyHintTimer),this.applyHintTimer=window.setTimeout(()=>{this.applyHint.setAttribute("data-show","false")},1400)}open(e){e&&(this.onChange=e),this.clearSearch(),this.disarmResetAll(),this.syncNavActive(),this.buildContent(),this.root.setAttribute("data-open","true"),this.root.querySelector(".fms-window").focus()}setSystemFonts(e){let n=(Array.isArray(e)?e:[]).filter(i=>typeof i=="string").map(i=>i.trim()).filter(i=>i.length>0);if(n.length!==0){Mn(n);for(let i of ue)i.innerHTML="",ce(i,n)}}applyPending(){for(let[e,n]of S)this.commitItem(e,n);S.clear(),h.reapplyAll();for(let e of this.contentEl.querySelectorAll(".fms-row")){let n=e.dataset.key,i=Te.find(r=>r.key===n);i&&this.syncRowState(e,i)}}close(){S.size>0&&this.applyPending(),this.disarmResetAll(),this.root.setAttribute("data-open","false")}get isOpen(){return this.root.getAttribute("data-open")==="true"}};function xi(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}var pe=new Oe;var Ci={live:"\u5B9E\u65F6",source:"\u6E90\u7801",viewer:"\u9605\u8BFB",mindmap:"\u5BFC\u56FE",slides:"\u5E7B\u706F\u7247"};function Hn(){let t=s.editor?.getView(),e=t?.state.doc,n=e?.lines??0,i=e?.length??0,r=Math.round(i/102.4)/10,o=s.currentEditorMode,a=`${Ci[o]??o} \xB7 \u884C ${n} \xB7 ${r}KB`,l={mode:o,lines:n,bytes:i};if(o==="mindmap"&&s.mindmapApp){let d=s.mindmapApp.debugStats();return Object.assign(l,d),{line:`${a} \xB7 \u8282\u70B9 ${d.nodes}/${d.mounted} \xB7 \u961F\u5217 ${d.queue}`,raw:l,createdTotal:Number(d.createdTotal)||0}}if(o==="slides"&&s.slidesApp){let d=s.slidesApp.debugStats();return Object.assign(l,d),{line:`${a} \xB7 \u9875 ${d.pages} \xB7 \u5757 ${d.blocks}`,raw:l}}if(t){let d=t.viewportLineBlocks.length;return l.visibleLines=d,{line:`${a} \xB7 \u89C6\u53E3 ${d}\u884C`,raw:l}}return{line:a,raw:l}}var Rn=10*1024*1024,Li=["image/png","image/jpeg","image/gif","image/webp","image/svg+xml","image/bmp"],Ti=[".png",".jpg",".jpeg",".gif",".webp",".svg",".bmp"],F=new Map,De="";function Mi(t){t.dataTransfer?.types.includes("Files")&&(t.preventDefault(),t.stopPropagation(),t.dataTransfer.dropEffect="copy")}function Ai(t){let e=t.replace(/\\/g,"/").trim();return e.startsWith("./")||e.startsWith("../")||e.startsWith("/")?e:`./${e}`}function In(t,e){let n=t.match(e);return n?n.length:0}function ki(t){let e=In(t,/!\[\[/g),n=In(t,/!\[[^\]]*?\]\(/g);return e>n?"wiki":"markdown"}function Ni(t,e,n){let i=Ai(t),r=e.trim().replace(/]/g,"\\]").replace(/\[/g,"\\[");if(n==="wiki"){let o=r.replace(/\|/g,"\\|");return o?`![[${i}|${o}]]
`:`![[${i}]]
`}return`![${r}](${i})
`}function Hi(t,e,n){let i=t.dataTransfer?.files?.[0];if(!i)return;let r=Li.includes(i.type),o="."+i.name.split(".").pop()?.toLowerCase(),a=Ti.includes(o);if(!r&&!a)return;if(t.preventDefault(),i.size>Rn){n({type:"error",message:"\u753B\u50CF\u30B5\u30A4\u30BA\u304C\u5927\u304D\u3059\u304E\u307E\u3059\uFF08\u4E0A\u9650: 10MB\uFF09"});return}let l=e();if(!l)return;let d=l.posAtCoords({x:t.clientX,y:t.clientY});if(d===null)return;let c=new FileReader;c.onload=()=>{let u=c.result;F.set(i.name,{pos:d,altText:i.name}),n({type:"saveImage",data:u,fileName:i.name})},c.onerror=()=>{},c.readAsDataURL(i)}function Ii(t,e,n){if(e.composing)return!1;let i=t.clipboardData?.items;if(!i)return!1;let r=null;for(let c=0;c<i.length;c++)if(i[c].type.startsWith("image/")){r=i[c];break}if(!r)return!1;let o=r.getAsFile();if(!o)return!1;if(t.preventDefault(),o.size>Rn)return n({type:"error",message:"\u753B\u50CF\u30B5\u30A4\u30BA\u304C\u5927\u304D\u3059\u304E\u307E\u3059\uFF08\u4E0A\u9650: 10MB\uFF09"}),!0;let a=Ri(),l=e.state.selection.main.head,d=new FileReader;return d.onload=()=>{let c=d.result;F.set(a,{pos:l,altText:""}),n({type:"saveImage",data:c,fileName:a})},d.onerror=()=>{},d.readAsDataURL(o),!0}function Pn(t,e){document.body.addEventListener("dragenter",n=>{n.dataTransfer?.types.includes("Files")&&(n.preventDefault(),n.stopPropagation())},{capture:!0}),document.body.addEventListener("dragover",Mi,{capture:!0}),document.body.addEventListener("drop",n=>{n.dataTransfer?.types.includes("Files")&&(n.preventDefault(),n.stopPropagation()),Hi(n,t,e)},{capture:!0})}function On(t){return(e,n)=>Ii(e,n,t)}function Dn(t,e){let n=e();if(!n)return;let i;for(let[d,c]of F){i=c,F.delete(d);break}let r=i?.pos??n.state.selection.main.head,o=i?.altText??"",a=ki(n.state.doc.toString()),l=Ni(t.relativePath,o,a);n.dispatch({changes:{from:r,insert:l}}),`${t.relativePath}${r}`}function Bn(t,e){e({type:"error",message:`\u753B\u50CF\u306E\u4FDD\u5B58\u306B\u5931\u6557\u3057\u307E\u3057\u305F: ${t.error}`});for(let n of F.keys()){F.delete(n);break}}function Ri(){let t=new Date,e=o=>o.toString().padStart(2,"0"),n=`${t.getFullYear()}${e(t.getMonth()+1)}${e(t.getDate())}`,i=`${e(t.getHours())}${e(t.getMinutes())}${e(t.getSeconds())}`,r=`paste-${n}-${i}`;if(De===r){let o=t.getMilliseconds().toString().padStart(3,"0");return De=r,`${r}-${o}.png`}return De=r,`${r}.png`}function Fn(t){let e=performance.memory;return{heapUsedMB:e?Math.round(e.usedJSHeapSize/1048576):-1,heapTotalMB:e?Math.round(e.totalJSHeapSize/1048576):-1,domNodes:document.getElementsByTagName("*").length,docKB:Math.round(t.docLength/1024),docLines:t.docLines,mode:t.mode,map:t.mapStats,slides:t.slidesStats??null,caches:{mermaidSvg:lt.size,mermaidHeight:dt.size,mermaidPending:ut.size,widgetHeight:ct.size,mathScale:bt(),openScale:it(),...ht(),...ft()}}}function me(t){let e=document.getElementById("boot-status");if(!e)return;let n=e.querySelector(".boot-status-detail");n&&(n.textContent=t)}function $n(){document.getElementById("boot-status")?.setAttribute("hidden","true")}function Vn(){window.addEventListener("error",t=>{let e=t.error instanceof Error?t.error.message:t.message;if(e.includes("ResizeObserver loop"))return;let n=t.error instanceof Error?t.error.stack:void 0;p("ERROR",`Global error captured: message=${e}, source=${t.filename}, line=${t.lineno}, column=${t.colno}`),s.messageSender.sendError(e,n,"WEBVIEW_GLOBAL_ERROR")}),window.addEventListener("unhandledrejection",t=>{let e=t.reason instanceof Error?t.reason.message:String(t.reason),n=t.reason instanceof Error?t.reason.stack:void 0;p("ERROR",`Unhandled promise rejection captured: ${e}`),s.messageSender.sendError(e,n,"WEBVIEW_UNHANDLED_REJECTION")})}function Be(t){p("INFO",`Sending READY to extension: source=${t}, ctx.hasReceivedInit=${s.hasReceivedInit}`),s.messageSender.sendReady()}function he(t,e){setTimeout(()=>{if(s.hasReceivedInit){p("DEBUG",`READY retry skipped because INIT arrived: attempt=${e}`);return}p("WARN",`INIT not received yet, retrying READY: attempt=${e}, delayMs=${t}`),me(`Webview \u811A\u672C\u5DF2\u8FD0\u884C\uFF0C\u4F46\u8FD8\u6CA1\u6709\u6536\u5230 INIT\uFF0C\u6B63\u5728\u7B2C ${e} \u6B21\u91CD\u53D1 READY\u3002`),Be(`retry-${e}`)},t)}function Fe(t,e){if(s.hasInitialized){p("DEBUG",`Webview initialize skipped because it already ran: source=${t}`);return}s.hasInitialized=!0,me(`Webview \u811A\u672C\u5DF2\u8FD0\u884C\uFF0C\u521D\u59CB\u5316\u6765\u6E90\uFF1A${t}\uFF0C\u6B63\u5728\u7B49\u5F85\u6269\u5C55\u4FA7 INIT\u3002`),p("INFO",`Running Webview initialize: source=${t}`),e()}function Pi(t){let e=Number(t.name.slice(10)),n=t.parent;if(!n)return t.to;let i=t.nextSibling;for(;i;){let r=i.name??"",o=0;if(r.startsWith("ATXHeading")?o=Number(r.slice(10)):r==="SetextHeading1"?o=1:r==="SetextHeading2"&&(o=2),o!==0&&o<=e)return i.from;i=i.nextSibling}return n.to}function Oi(t,e){let n=t.state.doc.lineAt(e),i=O(t.state),r={node:null,from:-1};i.iterate({from:n.from,to:n.to+1,enter(a){(a.name==="ListMark"||a.name==="HeaderMark")&&a.from>r.from&&(r.from=a.from,r.node=a.node)}});let o=r.node?.parent??null;return o?o.name==="ListItem"?!!(o.getChild("BulletList")||o.getChild("OrderedList")):o.name.startsWith("ATXHeading")?n.to<Pi(o):!1:!1}function Di(t){let e=t.querySelector(".cm-md-gutter-fold");return e||(e=document.createElement("span"),e.className="cm-md-gutter-fold",e.innerHTML='<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',t.appendChild(e),e)}function _n(t){let e=t.dom.querySelector(".cm-lineNumbers");if(!e)return;let i=Array.from(e.querySelectorAll(".cm-gutterElement")).filter(o=>o.style.visibility!=="hidden"),r=t.viewportLineBlocks.filter(o=>o.type===0);i.forEach((o,a)=>{let l=r[a];if(!l)return;o.dataset.foldPos=String(l.from);let d=Oi(t,l.from),c=Ce(t.state).has(l.from);d?(o.classList.add("cm-md-foldable-line"),o.classList.toggle("is-folded",c),Di(o)):(o.classList.remove("cm-md-foldable-line","is-folded"),o.querySelector(".cm-md-gutter-fold")?.remove())})}function Wn(t){let e=t.target?.closest(".cm-md-gutter-fold");return e?e.closest(".cm-gutterElement"):null}function Bi(t,e){Wn(e)&&(e.preventDefault(),e.stopPropagation())}function Fi(t,e){let n=Wn(e);if(!n)return;let i=Number(n.dataset.foldPos);if(!Number.isInteger(i))return;e.preventDefault(),e.stopPropagation();let r=Ce(t.state);r.has(i)?r.delete(i):r.add(i),t.dispatch({effects:at.of(null)})}var fe=J.fromClass(class{constructor(t){this.view=t;this.attachGutter(),_n(t)}gutterEl=null;onMouseDown=t=>Bi(this.view,t);onClick=t=>Fi(this.view,t);attachGutter(){let t=this.view.dom.querySelector(".cm-lineNumbers");t!==this.gutterEl&&(this.gutterEl?.removeEventListener("mousedown",this.onMouseDown),this.gutterEl?.removeEventListener("click",this.onClick),this.gutterEl=t,t?.addEventListener("mousedown",this.onMouseDown),t?.addEventListener("click",this.onClick))}update(t){this.attachGutter(),_n(t.view)}destroy(){this.gutterEl?.removeEventListener("mousedown",this.onMouseDown),this.gutterEl?.removeEventListener("click",this.onClick),this.gutterEl=null}});function $i(t){let e=t.state,n=e.selection.main;if(!n.empty||!vt(e,n.head))return!1;let r=e.doc.lineAt(n.head).text.match(/^[ \t]*/)?.[0]??"";return t.dispatch({changes:{from:n.head,insert:`
`+r},selection:Y.cursor(n.head+1+r.length),userEvent:"input"}),!0}function Vi(t){let e=t.state,n=e.selection.main;if(!n.empty)return!1;let i=n.head,r=e.doc.lineAt(i),o=O(e).resolveInner(i,-1);for(;o&&o.name!=="ListItem";)o=o.parent??null;if(!o)return!1;let a=o.getChild("ListMark");if(!a)return!1;let l=e.sliceDoc(a.to,r.to);return/\S/.test(l)?!1:(a.from-r.from<=0?t.dispatch({changes:{from:r.from,to:r.to},selection:Y.cursor(r.from),userEvent:"input"}):(t.dispatch({changes:{from:a.from,to:r.to},userEvent:"input"}),t.dispatch({selection:Y.cursor(a.from,-1)})),!0)}var zn=Qe.highest(Z.of([{key:"Enter",run(t){return $i(t)||Vi(t)||rt(t)}}]));var Un=J.fromClass(class{constructor(t){this.view=t;requestAnimationFrame(()=>this.updateCount())}countEl=null;update(t){this.updateCount()}updateCount(){if(!Pt(this.view.state)){this.countEl&&(this.countEl.remove(),this.countEl=null);return}let t=Rt(this.view.state),e=new It(t);if(!e.valid){this.countEl&&(this.countEl.textContent="",this.countEl.style.display="none");return}if(!this.countEl||!this.countEl.parentElement){this.countEl=document.createElement("span"),this.countEl.className="cm-search-match-count";let d=this.view.dom.querySelector(".cm-search")?.querySelector('input[name="search"]');if(d)d.after(this.countEl);else return}this.countEl.style.display="";let n=e.getCursor(this.view.state),i=0,r=0,o=this.view.state.selection.main,a=n.next();for(;!a.done;)i++,a.value.from===o.from&&a.value.to===o.to&&(r=i),a=n.next();i===0?(this.countEl.textContent="\u65E0\u7ED3\u679C",this.countEl.classList.add("cm-search-match-count-none")):(this.countEl.classList.remove("cm-search-match-count-none"),r>0?this.countEl.textContent=`${r}/${i}`:this.countEl.textContent=`${i} \u4E2A\u7ED3\u679C`)}destroy(){this.countEl&&(this.countEl.remove(),this.countEl=null)}});function v(t){return nt.of({name:t.name,alias:t.alias,extensions:t.extensions,load:t.load})}var N=[v({name:"JavaScript",alias:["js","jsx","ecmascript","node"],extensions:["js","mjs","cjs","jsx"],load:async()=>(await import("./chunks/dist-E6DLYVT6.js")).javascript({jsx:!0})}),v({name:"TypeScript",alias:["ts","tsx","typescriptreact"],extensions:["ts","tsx","mts","cts"],load:async()=>(await import("./chunks/dist-E6DLYVT6.js")).javascript({typescript:!0,jsx:!0})}),v({name:"Python",alias:["py","py3"],extensions:["py","pyw"],load:async()=>(await import("./chunks/dist-7673QP27.js")).python()}),v({name:"HTML",alias:["htm","xhtml"],extensions:["html","htm"],load:async()=>(await import("./chunks/dist-YZPIA4NM.js")).html()}),v({name:"CSS",extensions:["css"],load:async()=>(await import("./chunks/dist-TLTPVM63.js")).css()}),v({name:"JSON",alias:["jsonc","json5"],extensions:["json"],load:async()=>(await import("./chunks/dist-DNINTG7I.js")).json()}),v({name:"Java",extensions:["java"],load:async()=>(await import("./chunks/dist-QITOIGKT.js")).java()}),v({name:"C++",alias:["cpp","c","cc","cxx","h","hpp"],extensions:["cpp","c","cc","h","hpp"],load:async()=>(await import("./chunks/dist-7MSKEPLG.js")).cpp()}),v({name:"Rust",alias:["rs"],extensions:["rs"],load:async()=>(await import("./chunks/dist-CTDMZNFP.js")).rust()}),v({name:"Go",alias:["golang"],extensions:["go"],load:async()=>(await import("./chunks/dist-GMICTEZM.js")).go()}),v({name:"SQL",extensions:["sql"],load:async()=>(await import("./chunks/dist-PCCK7L5M.js")).sql()}),v({name:"PHP",extensions:["php"],load:async()=>(await import("./chunks/dist-SILGLNCR.js")).php()}),v({name:"XML",alias:["svg","xsl","xsd"],extensions:["xml","svg","xsl"],load:async()=>(await import("./chunks/dist-DEGCHZPV.js")).xml()}),v({name:"YAML",alias:["yml"],extensions:["yaml","yml"],load:async()=>(await import("./chunks/dist-AEB5HCHG.js")).yaml()}),v({name:"Shell",alias:["bash","sh","zsh","ksh","shell"],extensions:["sh","bash","zsh"],load:async()=>new A(k.define((await import("./chunks/shell-XBPQQBX7.js")).shell))}),v({name:"PowerShell",alias:["ps1","psm1","pwsh"],extensions:["ps1","psm1"],load:async()=>new A(k.define((await import("./chunks/powershell-HT5V4QAT.js")).powerShell))}),v({name:"Ruby",alias:["rb"],extensions:["rb"],load:async()=>new A(k.define((await import("./chunks/ruby-FCDXB6FO.js")).ruby))}),v({name:"Dockerfile",alias:["docker"],extensions:["dockerfile"],load:async()=>new A(k.define((await import("./chunks/dockerfile-SOBMIQG4.js")).dockerFile))}),v({name:"TOML",extensions:["toml"],load:async()=>new A(k.define((await import("./chunks/toml-POJI6VFR.js")).toml))}),v({name:"Diff",alias:["patch"],extensions:["diff","patch"],load:async()=>new A(k.define((await import("./chunks/diff-ECKLWAZL.js")).diff))})];function $e(){let t=document.body;return t.classList.contains("vscode-light")||t.classList.contains("vscode-high-contrast-light")?"light":"dark"}function _i(t){let e=window.__vscodeApi;e&&e.postMessage({type:"copyToClipboard",text:t})}function qn(t,e=""){t.view&&t.destroy();let n=[t.editableCompartment.of(y.editable.of(!0)),t.lineWrappingCompartment.of(y.lineWrapping),t.activeLineCompartment.of(h.getBoolean("highlightActiveLine")?te():[]),t.whitespaceCompartment.of([ee(),h.getBoolean("highlightWhitespace")?ie():[]]),t.lineNumbersCompartment.of([ne(),fe]),Q.allowMultipleSelections.of(!0),Ze(),Bt,et({eventFilter:r=>r.altKey&&r.shiftKey}),tt({key:"Alt"}),y.domEventHandlers({wheel:(r,o)=>r.ctrlKey||r.metaKey?(r.preventDefault(),r.stopPropagation(),t.adjustFontScale(r.deltaY),!0):r.altKey?(r.preventDefault(),o.scrollDOM.scrollTop+=r.deltaY*5,!0):!1,scroll:(r,o)=>(t.scheduleViewportLineReport(o),!1),mousedown(r,o){if(!o.state.facet(y.editable)){let a=r.target;if(a instanceof Element&&a.closest('.cm-search, input, textarea, select, button, [contenteditable="true"]'))return!1;o.dom.hasAttribute("tabindex")||o.dom.setAttribute("tabindex","0"),o.dom.focus({preventScroll:!0})}return!1},keydown(r,o){if((r.ctrlKey||r.metaKey)&&r.key==="c"&&!r.shiftKey&&!o.state.facet(y.editable)){let{from:a,to:l}=o.state.selection.main;if(a!==l){let d=o.state.sliceDoc(a,l);return r.preventDefault(),_i(d),!0}}return!1}}),Lt(),Ht({top:!0}),Un,Vt,Q.phrases.of(Ft),zn,Z.of([Nt,...Dt,...$t,...Ot,...kt,...At]),ot({base:st,codeLanguages:N,addKeymap:!0}),t.themeCompartment.of(Me($e())),t.livePreviewCompartment.of(_()),y.updateListener.of(r=>{if(r.docChanged&&(`${t.suppressOnChange}${r.view.composing}`,t.onChangeCallback),r.docChanged&&!t.suppressOnChange&&!r.view.composing&&t.onChangeCallback&&(`${r.state.doc.length}`,t.onChangeCallback(r.state.doc.toString())),(r.docChanged||r.selectionSet)&&t.onSelectionChangeCallback){let o=r.state.doc.lineAt(r.state.selection.main.head).number;t.onSelectionChangeCallback(o)}(r.docChanged||r.viewportChanged)&&t.scheduleViewportLineReport(r.view)}),y.domEventHandlers({compositionend:(r,o)=>(setTimeout(()=>{!t.suppressOnChange&&t.onChangeCallback&&!o.composing&&t.onChangeCallback(o.state.doc.toString())},20),!1),paste:(r,o)=>t.pasteHandler?t.pasteHandler(r,o):!1})],i=Q.create({doc:e,extensions:n});return t.view=new y({state:i,parent:t.container}),t.applyFontScale(),t.reportViewportLine(t.view),Wi(t),zi(t),Promise.resolve()}function Wi(t){window.__lwmDebug={buildStamp:"2026-10-26T2100+quote-fix",view:t.view,syntaxTree:()=>O(t.view.state),getSourceRange:()=>gt(t.view.state)}}function zi(t){let e=$e();t.themeObserver=new MutationObserver(()=>{let n=$e();n===e||!t.view||(e=n,t.view.dispatch({effects:t.themeCompartment.reconfigure(Me(n))}))}),t.themeObserver.observe(document.body,{attributes:!0,attributeFilter:["class"]})}var q=class extends Error{constructor(e){super(`Cannot ${e}: Editor is not initialized. Call create() first.`),this.name="EditorNotReadyError"}},Ve=class extends Error{constructor(){super("Container element is required and must be a valid HTMLElement."),this.name="InvalidContainerError"}},ge=class t{container;view=null;onChangeCallback;onSelectionChangeCallback;onViewportLineChangeCallback;viewportLineFrame=null;lastReportedViewportLine=null;suppressOnChange=!1;editableCompartment=new C;livePreviewCompartment=new C;themeCompartment=new C;themeObserver=null;lineWrappingCompartment=new C;lineNumbersCompartment=new C;activeLineCompartment=new C;whitespaceCompartment=new C;pasteHandler=null;fontScaleChangeHandler=null;fontScale=1;lineGutterGap=Number.NaN;static MIN_FONT_SCALE=.5;static MAX_FONT_SCALE=2;static FONT_SCALE_STEP=.1;constructor(e){if(!e)throw new Ve;this.container=e}applyFontScale(){this.container.style.setProperty("--livewritemd-font-scale",this.fontScale.toFixed(2))}adjustFontScale(e){let n=this.fontScale,i=e<0?1:-1,r=this.fontScale+i*t.FONT_SCALE_STEP;this.fontScale=Math.min(t.MAX_FONT_SCALE,Math.max(t.MIN_FONT_SCALE,r)),this.applyFontScale(),this.fontScale!==n&&this.fontScaleChangeHandler?.(this.fontScale)}scheduleViewportLineReport(e){this.onViewportLineChangeCallback&&this.viewportLineFrame===null&&(this.viewportLineFrame=window.requestAnimationFrame(()=>{this.viewportLineFrame=null,this.reportViewportLine(e)}))}reportViewportLine(e){if(!this.onViewportLineChangeCallback)return;let n=e.lineBlockAtHeight(e.scrollDOM.scrollTop),i=e.state.doc.lineAt(n.from).number;i!==this.lastReportedViewportLine&&(this.lastReportedViewportLine=i,this.onViewportLineChangeCallback(i))}create(e=""){return qn(this,e)}destroy(){this.themeObserver&&(this.themeObserver.disconnect(),this.themeObserver=null),this.view&&(this.viewportLineFrame!==null&&(window.cancelAnimationFrame(this.viewportLineFrame),this.viewportLineFrame=null),this.view.destroy(),this.view=null),this.onChangeCallback=void 0,this.onViewportLineChangeCallback=void 0,this.pasteHandler=null,this.fontScaleChangeHandler=null,this.suppressOnChange=!1,this.lastReportedViewportLine=null}setContent(e){if(!this.view)throw new q("setContent");if(this.view.composing){`${e.length}`;return}this.suppressOnChange=!0;try{if(this.view.state.doc.toString()===e){`${e.length}`;return}let n=this.view.state.doc.length,i=this.view.state.selection.main.head,r=Math.min(i,e.length),o=this.view.scrollDOM.scrollTop;`${n}${e.length}${i}${r}${this.view.hasFocus}`,this.view.dispatch({changes:{from:0,to:n,insert:e},selection:{anchor:r},annotations:Je.addToHistory.of(!1)}),`${this.view.hasFocus}`,this.view.scrollDOM.scrollTop=o}finally{this.suppressOnChange=!1}}getContent(){if(!this.view)throw new q("getContent");return this.view.state.doc.toString()}getCurrentLine(){if(!this.view)throw new q("getCurrentLine");return this.view.state.doc.lineAt(this.view.state.selection.main.head).number}onChange(e){this.onChangeCallback=e}onSelectionChange(e){this.onSelectionChangeCallback=e}onViewportLineChange(e){this.onViewportLineChangeCallback=e,this.view&&this.reportViewportLine(this.view)}setPasteHandler(e){this.pasteHandler=e}setFontScaleChangeHandler(e){this.fontScaleChangeHandler=e}getView(){return this.view}isReady(){return this.view!==null}isEditable(){return this.view?this.view.state.facet(y.editable):!1}focus(){this.view&&this.view.focus()}getViewportMiddleLine(){if(!this.view)return null;let e=this.view.scrollDOM,n=e.clientHeight;if(n<=0)return null;let i=this.view.lineBlockAtHeight(e.scrollTop+n/2);return this.view.state.doc.lineAt(i.from).number}scrollToLine(e){if(!this.view||!Number.isFinite(e)||e<1)return;let n=Math.min(this.view.state.doc.lines,Math.floor(e)),i=this.view.state.doc.line(n);this.view.dispatch({selection:{anchor:i.from},effects:y.scrollIntoView(i.from,{y:"start"})}),this.view.focus()}revealLine(e){if(!this.view||!Number.isFinite(e)||e<1)return;let n=Math.min(this.view.state.doc.lines,Math.floor(e)),i=this.view.state.doc.line(n);this.view.dispatch({effects:y.scrollIntoView(i.from,{y:"center"})})}setEditable(e){this.view&&this.view.dispatch({effects:this.editableCompartment.reconfigure(y.editable.of(e))})}setMode(e){if(!this.view)return;let n=e!=="viewer",i=e!=="source";this.view.dispatch({effects:[this.editableCompartment.reconfigure(y.editable.of(n)),this.livePreviewCompartment.reconfigure(i?_():[])]})}applySettings(e){if(!this.view)return;this.fontScale=Math.min(t.MAX_FONT_SCALE,Math.max(t.MIN_FONT_SCALE,e.fontScale)),this.view.dispatch({effects:this.lineNumbersCompartment.reconfigure(e.lineNumbers?[ne(),fe]:[])}),this.view.dispatch({effects:this.lineWrappingCompartment.reconfigure(e.wordWrap?y.lineWrapping:[])}),this.view.dispatch({effects:[this.activeLineCompartment.reconfigure(h.getBoolean("highlightActiveLine")?te():[]),this.whitespaceCompartment.reconfigure([ee(),h.getBoolean("highlightWhitespace")?ie():[]])]});let n=this.container,i=e.readableLineLength>0?`${e.readableLineLength}px`:"100%";n.style.setProperty("--livewritemd-max-width",i),Number.isFinite(e.lineGutterGap)&&e.lineGutterGap!==this.lineGutterGap&&(Number.isNaN(this.lineGutterGap)||this.view.dispatch({effects:re.of(null)}),this.lineGutterGap=e.lineGutterGap),this.applyFontScale()}};function R(){let t=document.getElementById("editor");return t||(t=document.createElement("div"),t.id="editor",document.body.appendChild(t)),t}function ve(){return document.getElementById("mindmap")}function be(){return document.getElementById("slides")}function Yn(t){try{return(decodeURIComponent(t.split("?")[0]??t).split(/[\\/]/).pop()??"").replace(/\.(md|markdown)$/i,"")}catch{return(t.split(/[\\/]/).pop()??"").replace(/\.(md|markdown)$/i,"")}}function Ee(){return{mindmapTheme:h.getString("mindmapTheme")||"auto",mindmapDefaultExpandLevel:h.getNumber("mindmapDefaultExpandLevel"),mindmapNodeMaxWidth:h.getNumber("mindmapNodeMaxWidth")||20,mindmapNodeMaxLines:h.getNumber("mindmapNodeMaxLines")||3,mindmapCodeWidth:h.getNumber("mindmapCodeWidth")||60,mindmapGestureCrisp:h.getBoolean("mindmapGestureCrisp"),mindmapInternalLinks:h.getBoolean("mindmapInternalLinks"),quickCardEnabled:h.getBoolean("quickCardEnabled"),quickCardWidth:h.getNumber("quickCardWidth")||280}}function K(t,e="mindmap"){let n=s.editor?.getView();if(!n){p("WARN",`${e} edit: CodeMirror view is not ready, sending content directly`),s.debouncedSendContentChange(t),s.debouncedSendContentChange.flush();return}let i=n.state.doc.toString();if(i===t)return;let r=0,o=Math.min(i.length,t.length);for(;r<o&&i.charCodeAt(r)===t.charCodeAt(r);)r+=1;let a=i.length,l=t.length;for(;a>r&&l>r&&i.charCodeAt(a-1)===t.charCodeAt(l-1);)a-=1,l-=1;n.dispatch({changes:{from:r,to:a,insert:t.slice(r,l)}}),s.debouncedSendContentChange.flush()}function Gn(t){K(t,"mindmap")}function jn(t){let e=s.editor?.getView();if(!e)return;(t==="undo"?Tt(e):Mt(e))&&s.mindmapApp?.setDocument(e.state.doc.toString(),s.mindmapFileName)}var f=null,$=null,_e=0,H=0,G=null,I=null,We=-1,j=null;function ze(){return s.currentEditorMode==="live"&&h.getBoolean("quickCardEnabled")&&!!s.editor?.isReady()}async function Ui(){if(f)return f;if(!ze())return null;if($)return $;let t=document.getElementById("editor-pane");if(!t)return null;let e=_e;return $=(async()=>{try{let[{QuickCardRail:n},{ensureMindMapCss:i}]=await Promise.all([import("./chunks/quickCardRail-OIA2L2P5.js"),import("./chunks/styles-KWS632UI.js")]);if(e!==_e||!ze())return null;i();let r=new n(t,{getMarkdown:()=>s.editor?.getContent()??"",commit:o=>{K(o,"live"),f?.refresh(o)},getSettings:()=>({enabled:h.getBoolean("quickCardEnabled"),width:h.getNumber("quickCardWidth")||280}),getTheme:()=>s.currentTheme,codeLanguages:N,getFileName:()=>s.mindmapFileName,onResize:o=>{h.set("quickCardWidth",o),s.vscode.postMessage({type:w.UPDATE_SETTING,key:"quickCardWidth",value:o})},copyText:async o=>{try{return await mt(o),!0}catch{try{return await navigator.clipboard.writeText(o),!0}catch{return!1}}},readText:async()=>{try{return await navigator.clipboard.readText()}catch{return""}},onCardDragPreview:o=>{o?qi(o):T()},onCardDropOnMap:(o,a,l)=>{Gi(o,a,l)}});return f=r,r.setHostVisible(!0),r.refresh(),j?.disconnect(),j=new ResizeObserver(()=>f?.relayout()),j.observe(t),r}catch(n){let i=n instanceof Error?n.message:String(n);return p("ERROR",`Live quick cards init failed: ${i}`),null}finally{$=null}})(),$}function Qn(){_e+=1,$=null,f?.destroy(),f=null,j?.disconnect(),j=null,window.clearTimeout(H),H=0,G=null,T(),I?.remove(),I=null}function ye(t,e=!1){f&&(window.clearTimeout(H),H=0,G=null,f.refresh(t,e))}function Jn(t){f&&(G=t,!H&&(H=window.setTimeout(()=>{H=0;let e=G;G=null,f?.refresh(e??void 0)},180)))}function V(){if(!ze()){f?.setHostVisible(!1),T();return}if(!f){Ui();return}f.setHostVisible(!0),f.applySettings(),ye()}function qi(t){let e=document.getElementById("editor-pane"),n=s.editor?.getView();if(!e||!n)return;let i=n.posAtCoords({x:t.clientX,y:t.clientY});if(i===null){T();return}let r=n.state.doc.lineAt(i);if(r.number===We&&I?.isConnected)return;let o=n.coordsAtPos(r.from);if(!o){T();return}let a=I;(!a||!a.isConnected)&&(a=document.createElement("div"),a.className="lwm-qcards-live-dropmark",e.appendChild(a),I=a);let l=e.getBoundingClientRect(),d=n.contentDOM.getBoundingClientRect(),c=Math.max(0,d.left-l.left);We=r.number,a.style.display="block",a.style.left=`${Math.round(c)}px`,a.style.width=`${Math.round(Math.max(0,Math.min(d.width,l.width-c)))}px`,a.style.top=`${Math.round(o.top-l.top)}px`}function T(){We=-1,I&&(I.style.display="none")}async function Gi(t,e,n){let i=s.editor?.getView();if(!i)return;let r=i.posAtCoords({x:e,y:n});if(r===null)return;let o=i.state.doc.toString(),a=i.state.doc.lineAt(r).number-1,{parseQuickCards:l,deleteQuickCard:d}=await import("./chunks/staging-P7TSIRJE.js"),c=s.editor?.getView();if(!c||c.state.doc.toString()!==o)return;let u=l(o)[t];if(!u||!u.text.trim()||a>=u.fromLine&&a<=u.toLine)return;let m=o.split(`
`),g=u.fromLine;for(;g>0&&m[g-1].trim()==="";)g-=1;let E=u.toLine+1;for(;E<m.length&&m[E].trim()==="";)E+=1;let b=g>0&&E<m.length?1:0,M=u.toLine-u.fromLine+1+(u.fromLine-g)+(E-u.toLine-1)-b,P;a<g?P=a:a>=E?P=a-M:E>=m.length?P=Number.MAX_SAFE_INTEGER:P=g;let Se=d(o,t),Ye=ji(Se,P,u.text);Ye!==o&&K(Ye,"live")}function ji(t,e,n){let i=t.split(`
`),r=Math.max(0,Math.min(e,i.length)),o=n.replace(/\r\n?/g,`
`).split(`
`),a=i.slice(0,r),l=a[a.length-1];l!==void 0&&l.trim()!==""&&a.push(""),a.push(...o);let d=i.slice(r),c=d[0];return c!==void 0&&c.trim()!==""&&a.push(""),a.push(...d),a.join(`
`)}function Ki(t){if(f){if((t.ctrlKey||t.metaKey)&&!t.altKey&&t.key.toLowerCase()==="s"&&f.debugState().editing){t.preventDefault(),t.stopPropagation(),f.flushEdit(),s.vscode.postMessage({type:w.SAVE_DOCUMENT,content:s.editor?.getContent()??""});return}f.handleKey(t)}}window.addEventListener("keydown",Ki,!0);async function Ue(){let t=ve(),e=R(),n=s.editor?.getViewportMiddleLine()??null;if(e.hidden=!0,t.hidden=!1,!s.mindmapApp){let{MindMapApp:i}=await import("./chunks/mindmapApp-NBTTKVYG.js");s.mindmapApp=new i(t,{onEdit:Gn,onSave:r=>{Gn(r),s.vscode.postMessage({type:w.SAVE_DOCUMENT,content:r})},onUndo:()=>jn("undo"),onRedo:()=>jn("redo"),codeLanguages:N,onSelectLine:r=>s.outlinePanel?.setActiveLine(r),onExport:r=>{s.vscode.postMessage({type:"saveMindmapExport",...r})},onPersistSetting:(r,o)=>{h.set(r,o),s.vscode.postMessage({type:w.UPDATE_SETTING,key:r,value:o})}}),s.mindmapApp.setTheme(s.currentTheme),s.mindmapApp.setSettings(Ee())}s.editor&&s.editor.isReady()&&s.mindmapApp.setDocument(s.editor.getContent(),s.mindmapFileName),await s.mindmapApp.whenReady(),s.mindmapApp.setActive(!0),n!==null&&s.mindmapApp.focusLineFromEditor(n-1),p("INFO","Mindmap mode activated")}function Kn(){let t=s.mindmapApp?.getFocusLine0()??null;ve().hidden=!0,R().hidden=!1,s.mindmapApp?.setActive(!1),requestAnimationFrame(()=>{s.editor?.getView()?.requestMeasure(),t!==null&&s.editor?.scrollToLine(t+1)})}async function qe(){let t=be(),e=R(),n=s.editor&&s.editor.isReady()?Math.max(0,s.editor.getCurrentLine()-1):null;if(e.hidden=!0,t.hidden=!1,!s.slidesApp){let{SlidesApp:i}=await import("./chunks/slidesApp-QDI3SW2C.js");s.slidesApp=new i(t,{onEdit:r=>K(r,"slides"),onSave:r=>{K(r,"slides"),s.vscode.postMessage({type:w.SAVE_DOCUMENT,content:r})},onPersistSetting:(r,o)=>{h.set(r,o),s.vscode.postMessage({type:w.UPDATE_SETTING,key:r,value:o})},codeLanguages:N,onPagesChange:()=>s.outlinePanel?.refresh(),onActiveLineChange:r=>{r!==null&&s.outlinePanel?.setActiveLine(r+1)},onWindowFullscreen:r=>{s.vscode.postMessage({type:w.SLIDES_FULLSCREEN,on:r})}}),s.slidesApp.setEditorTheme(s.currentTheme),s.slidesApp.applySettings()}s.outlinePanel?.setMetaProvider(i=>s.slidesApp?.getOutlinePageLabel(i)??""),s.slidesApp.setDocument(s.editor?.getContent()??"",s.mindmapFileName),s.slidesApp.setActive(!0,n),await s.slidesApp.whenReady(),p("INFO","Slides mode activated")}function Xn(){let t=be(),e=s.slidesApp?.getCurrentLine0()??null;s.slidesApp?.setActive(!1),s.outlinePanel?.setMetaProvider(null),t.hidden=!0,R().hidden=!1,requestAnimationFrame(()=>{let n=s.editor?.getView();n?.requestMeasure(),n&&n.dispatch({effects:re.of(null)}),e!==null&&s.editor?.scrollToLine(e+1)})}async function Zn(t){let e=s.currentEditorMode;if(s.currentEditorMode=t,t==="mindmap"){f?.setHostVisible(!1),T(),Xn(),await Ue();return}if(t==="slides"){f?.setHostVisible(!1),T(),Kn(),await qe();return}if(Xn(),Kn(),s.editor&&s.editor.isReady()){s.editor.setMode(t);let n=i=>i==="live"||i==="viewer"||i==="source";if(e!==t&&n(e)&&n(t)){let i=s.editor.getCurrentLine();requestAnimationFrame(()=>{s.editor?.getView()?.requestMeasure(),s.editor?.revealLine(i)})}}t==="live"?V():(f?.setHostVisible(!1),T())}function ei(){let t=getComputedStyle(document.documentElement).getPropertyValue("--livewritemd-outline-width"),e=Number.parseFloat(t);return!Number.isFinite(e)||e<=0?280:Math.round(e)}function Ge(){if(!(!s.editor||!s.editor.isReady()))try{s.outlinePanel?.setActiveLine(s.editor.getCurrentLine())}catch(t){let e=t instanceof Error?t.message:String(t);p("ERROR",`Sync outline active line skipped: ${e}`)}}function we(t){return t instanceof Element?!!t.closest('.cm-search, input, textarea, select, button, [contenteditable="true"], [role="textbox"]'):!1}var X=class{currentTheme;constructor(e="dark"){this.currentTheme=e,this.applyThemeToDOM()}setTheme(e){this.currentTheme=e,this.applyThemeToDOM()}getCurrentTheme(){return this.currentTheme}applyThemeToDOM(){document.body.setAttribute("data-theme",this.currentTheme)}};function je(){return{search:[],replace:[]}}function ni(t){let e=t.trim();return e.length>0?e:null}function ti(t){if(!Array.isArray(t))return[];let e=new Set,n=[];for(let i of t){if(typeof i!="string")continue;let r=ni(i);!r||e.has(r)||(e.add(r),n.push(r))}return n.slice(0,20)}function Ke(t){if(!t||typeof t!="object")return je();let e=t;return{search:ti(e.search),replace:ti(e.replace)}}function ii(t,e,n){let i=ni(n);if(!i)return t;let o=[i,...t[e].filter(a=>a!==i)].slice(0,20);return{search:e==="search"?o:t.search,replace:e==="replace"?o:t.replace}}var Xi=0,Xe=class{view;historyState;onChange;searchListEl;replaceListEl;searchListId;replaceListId;handleRootEvent=e=>{if(this.destroyed)return;let n=e.target instanceof HTMLInputElement?e.target:null;if(!n)return;let i=this.resolveInputKind(n);i&&(e.type==="keydown"&&e.key!=="Enter"||(e.type==="change"||e.type==="keydown")&&this.recordHistory(i,n.value))};observer;destroyed=!1;constructor(e,n,i){this.view=e,this.onChange=i,this.historyState=Ke(n);let r=++Xi;this.searchListId=`livewritemd-search-history-search-${r}`,this.replaceListId=`livewritemd-search-history-replace-${r}`,this.searchListEl=document.createElement("datalist"),this.searchListEl.id=this.searchListId,this.searchListEl.hidden=!0,this.replaceListEl=document.createElement("datalist"),this.replaceListEl.id=this.replaceListId,this.replaceListEl.hidden=!0,this.mountHistoryLists(),this.renderHistoryLists(),this.syncPanelInputs(),this.view.dom.addEventListener("change",this.handleRootEvent,!0),this.view.dom.addEventListener("keydown",this.handleRootEvent,!0),this.observer=new MutationObserver(()=>{this.syncPanelInputs()}),this.observer.observe(this.view.dom,{childList:!0,subtree:!0})}setHistory(e){this.destroyed||(this.historyState=Ke(e),this.renderHistoryLists(),this.syncPanelInputs())}destroy(){this.destroyed||(this.destroyed=!0,this.view.dom.removeEventListener("change",this.handleRootEvent,!0),this.view.dom.removeEventListener("keydown",this.handleRootEvent,!0),this.observer.disconnect(),this.searchListEl.remove(),this.replaceListEl.remove())}mountHistoryLists(){this.view.dom.append(this.searchListEl,this.replaceListEl)}renderHistoryLists(){this.renderList(this.searchListEl,this.historyState.search),this.renderList(this.replaceListEl,this.historyState.replace)}renderList(e,n){e.replaceChildren(...n.map(i=>{let r=document.createElement("option");return r.value=i,r}))}resolveInputKind(e){let n=e.getAttribute("name");return n==="search"?"search":n==="replace"?"replace":null}recordHistory(e,n){let i=ii(this.historyState,e,n);this.areHistoryStatesEqual(this.historyState,i)||(this.historyState=i,this.renderHistoryLists(),this.onChange(this.historyState))}syncPanelInputs(){let e=this.view.dom.querySelector('.cm-search input[name="search"]');e&&e.setAttribute("list",this.searchListId);let n=this.view.dom.querySelector('.cm-search input[name="replace"]');n&&n.setAttribute("list",this.replaceListId)}areHistoryStatesEqual(e,n){return this.areHistoryListsEqual(e.search,n.search)&&this.areHistoryListsEqual(e.replace,n.replace)}areHistoryListsEqual(e,n){if(e.length!==n.length)return!1;for(let i=0;i<e.length;i+=1)if(e[i]!==n[i])return!1;return!0}};function ri(t,e,n){let i=e??je();return new Xe(t,i,n)}async function oi(t,e,n,i,r,o,a,l){s.hasReceivedInit=!0,me("\u5DF2\u6536\u5230 INIT\uFF0C\u6B63\u5728\u521B\u5EFA CodeMirror \u7F16\u8F91\u5668\u3002"),p("INFO",`INIT received: contentLength=${t.length}, theme=${e}`),await new Promise(d=>setTimeout(d,0)),s.currentTheme=e,s.mindmapFileName=Yn(n);try{s.searchHistoryController?.destroy(),s.searchHistoryController=null,s.currentDocumentUri=n,h.replaceAll(l??{}),D(),Number.isFinite(a??NaN)&&s.outlinePanel?.setWidth(a);let d=R();p("INFO",`Editor host prepared: id=${d.id}, childCount=${d.childElementCount}, documentUri=${n}`),Qn(),s.editor&&(p("DEBUG","Destroying existing CodeMirror ctx.editor before INIT rebuild"),s.editor.destroy(),s.editor=null),s.mindmapApp?.destroy(),s.mindmapApp=null,ve().hidden=!0,s.slidesApp?.destroy(),s.slidesApp=null,be().hidden=!0,R().hidden=!1,p("INFO","Creating CodeMirror ctx.editor instance"),s.editor=new ge(d),s.editor.setFontScaleChangeHandler(m=>{s.messageSender.sendFontScaleChange(m)}),s.editor.onSelectionChange(m=>{s.outlinePanel?.setActiveLine(m)}),s.editor.onViewportLineChange(m=>{s.outlinePanel?.setActiveLine(m)}),p("INFO",`Calling CodeMirrorEditor.create: contentLength=${t.length}`),await s.editor.create(t),p("INFO","CodeMirrorEditor.create completed"),s.searchHistoryController?.destroy();let c=s.editor.getView();if(!c)throw new Error("Cannot initialize search history controller: ctx.editor view is missing.");if(s.searchHistoryController=ri(c,i,m=>{s.messageSender.sendSearchHistoryChange(m)}),$n(),s.currentEditorMode=o??"live",s.editorContextMenu?.attach(s.editor.getView()?.contentDOM??null),s.editor.onChange(m=>{s.debouncedSetOutlineContent(m),s.debouncedSendContentChange(m),Jn(m)}),s.outlinePanel?.setContent(t),Ge(),Number.isFinite(a??NaN)&&s.outlinePanel?.setWidth(a),s.themeManager?s.themeManager.setTheme(e):s.themeManager=new X(e),Le(e),s.editor.isReady()){let m=s.editor.view;m&&Ae(m,e)}Pn(()=>s.editor?.getView()??null,m=>s.vscode.postMessage(m));let u=On(m=>s.vscode.postMessage(m));s.editor.setPasteHandler(u),r&&(s.editor.applySettings(r),p("INFO",`Settings applied: lineNumbers=${r.lineNumbers}, wordWrap=${r.wordWrap}, readableLineLength=${r.readableLineLength}, fontScale=${r.fontScale}`)),o==="mindmap"?(await Ue(),s.currentEditorMode="mindmap",p("INFO","Default ctx.editor mode applied: mindmap")):o==="slides"?(await qe(),s.currentEditorMode="slides",p("INFO","Default ctx.editor mode applied: slides")):o&&o!=="live"&&(s.editor.setMode(o),s.currentEditorMode=o,p("INFO",`Default ctx.editor mode applied: ${o}`)),document.getElementById("editor-pane")?.setAttribute("data-lwm-theme",e),V(),p("INFO","CodeMirror ctx.editor initialized successfully")}catch(d){let c=d instanceof Error?d.message:String(d),u=d instanceof Error?d.stack:void 0;p("ERROR",`Editor initialization failed: ${c}`),s.messageSender.sendError(c,u,"EDITOR_INIT_ERROR")}}function si(t){if(p("DEBUG",`UPDATE received: contentLength=${t.length}`),`${t.length}${s.editor?.isReady()}`,!s.editor||!s.editor.isReady()){p("ERROR","Cannot update: ctx.editor not ready");return}try{s.editor.setContent(t),s.outlinePanel?.setContent(t),s.mindmapApp?.setDocument(t,s.mindmapFileName),s.slidesApp?.setDocument(t,s.mindmapFileName),ye(t),Ge(),p("DEBUG","UPDATE applied successfully"),document.getElementById("reload-content")?.classList.remove("spinning")}catch(e){let n=e instanceof Error?e.message:String(e),i=e instanceof Error?e.stack:void 0;p("ERROR",`Update failed: ${n}`),s.messageSender.sendError(n,i,"SYNC_ERROR")}}function ai(t){p("DEBUG",`THEME_CHANGE received: theme=${t}`),s.currentTheme=t,s.mindmapApp?.setTheme(t),s.slidesApp?.setEditorTheme(t),document.getElementById("editor-pane")?.setAttribute("data-lwm-theme",t),ye(void 0,!0);try{if(s.themeManager?s.themeManager.setTheme(t):s.themeManager=new X(t),Le(t),s.editor&&s.editor.isReady()){let e=s.editor.view;e&&Ae(e,t)}p("DEBUG","Theme applied successfully")}catch(e){let n=e instanceof Error?e.message:String(e);p("ERROR",`Theme change failed: ${n}`)}}pt(t=>s.vscode.postMessage(t));p("WARN",`[build] webview ${xt}`);Vn();p("INFO","Webview script loaded and diagnostics registered");window.livewritemdLog=p;window.__vscodeApi=s.vscode;function Fs(){return s.currentDocumentUri}function $s(){return s.vscode}function Vs(){return s.editor}function _s(){return s.themeManager}function li(){p("INFO",`Webview initializing: readyState=${document.readyState}, hasEditor=${!!document.getElementById("editor")}`),Ct(Hn),D();let t=document.getElementById("outline-pane"),e=document.getElementById("outline-content"),n=document.getElementById("outline-resizer");t&&e&&n?(s.outlinePanel=new de(t,e,n,{initialWidth:ei(),onWidthChange:l=>{s.vscode.postMessage({type:w.OUTLINE_WIDTH_CHANGE,width:l})},onNavigateToLine:l=>{s.currentEditorMode==="mindmap"&&s.mindmapApp&&s.mindmapApp.selectNodeAtLine(l-1)||s.currentEditorMode==="slides"&&s.slidesApp&&s.slidesApp.goToLine(l-1)||s.editor?.scrollToLine(l)},isEditable:()=>s.editor?.isEditable()??!1,getDocument:()=>s.editor?.getContent()??"",onApplyHeadingEdits:l=>{let d=s.editor?.getView();!d||l.length===0||d.dispatch({changes:l})}}),pe.registerChangeHandler((l,d)=>{s.vscode.postMessage({type:w.UPDATE_SETTING,key:l,value:d}),(l.startsWith("mindmap")||l.startsWith("quickCard"))&&s.mindmapApp&&s.mindmapApp.setSettings(Ee()),l.startsWith("slides")&&s.slidesApp&&s.slidesApp.applySettings(),l==="perfMonitor"&&D()}),p("INFO","Outline panel initialized")):p("ERROR","Outline panel DOM is missing, right-side outline is unavailable"),s.editorContextMenu=new St({onInsertImage:()=>s.messageSender.sendEditorAction("insertImage"),onExportAsHtml:()=>s.messageSender.sendEditorAction("exportAsHtml"),onExportAsPdf:()=>s.messageSender.sendEditorAction("exportAsPdf"),onDownloadRemoteImages:()=>s.messageSender.sendEditorAction("downloadRemoteImages"),resolveTableContext:l=>{let d=s.editor?.getView();if(!d||!s.editor?.isEditable())return!1;let c=d.posAtCoords({x:l.clientX,y:l.clientY});if(c===null)return!1;let u=Et(d.state,c);if(!u)return!1;let m=d.state.selection.main;return!m.empty&&m.from<=u.to&&u.from<=m.to||d.dispatch({selection:{anchor:u.from,head:u.to}}),!0},onTableCommand:l=>{let d=s.editor?.getView();d&&yt(d,l,d.state.selection.main.from)}}),window.addEventListener("message",l=>{let d=l.data;if(d?.type&&p("DEBUG",`Raw window message received: type=${d.type}`),d&&d.type==="init"&&(d.documentBaseUri&&(xe(d.documentBaseUri),p("DEBUG",`documentBaseUri set: ${d.documentBaseUri}`)),d.settings&&s.editor&&s.editor.isReady()&&s.editor.applySettings(d.settings)),d&&d.type==="viewerMode"&&(s.editor&&s.editor.isReady()&&(s.editor.setEditable(!d.readOnly),p("INFO",`Viewer mode: ${d.readOnly?"ON":"OFF"}`)),d.readOnly?s.currentEditorMode="viewer":s.currentEditorMode==="viewer"&&(s.currentEditorMode="live"),V()),d&&d.type==="editorMode"&&Zn(d.mode),d&&d.type==="settingsChange"&&s.editor&&s.editor.isReady()&&d.settings&&(s.editor.applySettings(d.settings),p("INFO",`Settings updated: lineNumbers=${d.settings.lineNumbers}, wordWrap=${d.settings.wordWrap}, readableLineLength=${d.settings.readableLineLength}, fontScale=${d.settings.fontScale}`)),d&&d.type==="outlineToggle"&&(s.outlinePanel?.toggleVisible(),p("INFO",`Outline visibility toggled: ${s.outlinePanel?.isOutlineVisible()}`)),d&&d.type==="imageSaved"&&Dn(d,()=>s.editor?.getView()??null),d&&d.type==="imageSaveError"&&Bn(d,c=>s.vscode.postMessage(c)),d&&d.type==="collectMemoryStats"){let c=s.editor?.getView();s.vscode.postMessage({type:"memoryStatsReport",stats:Fn({docLength:c?.state.doc.length??0,docLines:c?.state.doc.lines??0,mode:s.currentEditorMode,mapStats:s.mindmapApp?s.mindmapApp.debugStats():null,slidesStats:s.slidesApp?s.slidesApp.debugStats():null})})}});let i=new wt({onInit:(l,d,c,u,m,g,E,b)=>{oi(l,d,c,u,m,g,E,b)},onUpdate:si,onThemeChange:ai,onSettingsChange:l=>{l.allSettings&&h.replaceAll(l.allSettings),D(),s.mindmapApp?.setSettings(Ee()),s.slidesApp?.applySettings(),V(),l.settings&&s.editor?.isReady()&&s.editor.applySettings(l.settings),p("INFO","Settings change applied")},onOpenSettings:()=>{pe.open()},onSystemFonts:l=>{pe.setSystemFonts(l)}});p("INFO","Registering WebviewMessageHandler listener"),i.setup(),p("INFO","WebviewMessageHandler listener registered"),window.addEventListener("focus",()=>{if(p("DEBUG","Window focus event received"),s.currentEditorMode==="slides"){p("DEBUG","Editor focus restore skipped in slides mode");return}if(we(document.activeElement)){p("DEBUG","Editor focus restore skipped for interactive element");return}s.editor&&s.editor.isReady()&&(s.editor.focus(),p("DEBUG","Editor focus restored"))}),document.addEventListener("click",l=>{let d=l.target,c=document.getElementById("editor");if(c&&c.contains(d)){if(we(d))return;s.editor&&s.editor.isReady()&&setTimeout(()=>{we(document.activeElement)||s.editor?.focus()},10)}});let r=document.getElementById("reload-content");r&&r.addEventListener("click",()=>{r.classList.add("spinning"),s.vscode.postMessage({type:"reloadContent"}),setTimeout(()=>r.classList.remove("spinning"),3e3)});let o=document.getElementById("scroll-top"),a=document.getElementById("scroll-bottom");o&&o.addEventListener("click",()=>{let l=document.querySelector(".cm-scroller");l&&l.scrollTo({top:0,behavior:"instant"})}),a&&a.addEventListener("click",()=>{let l=document.querySelector(".cm-scroller");l&&l.scrollTo({top:l.scrollHeight,behavior:"instant"})}),Be("initial"),he(250,1),he(1e3,2),he(2500,3),p("INFO","READY handshake scheduled")}p("INFO",`Registering DOMContentLoaded listener: readyState=${document.readyState}`);document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>Fe("DOMContentLoaded",li)):Fe(`readyState-${document.readyState}`,li);export{Fs as getCurrentDocumentUri,Vs as getEditor,_s as getThemeManager,$s as getVsCodeApi};
//# sourceMappingURL=webview.js.map
