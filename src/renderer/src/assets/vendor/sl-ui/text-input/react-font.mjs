// A font-face declared only inside Shadow DOM is ignored by some browsers.
// Register only this local font in the document; all component CSS stays scoped.
export function retainFont(document,url){
 const head=document.head;
 if(!head)throw new Error('A document head is required for the bundled font');
 let style=[...head.querySelectorAll('style[data-sl-ui-font]')].find(node=>node.dataset.slUiFont===url);
 if(!style){style=document.createElement('style');style.dataset.slUiFont=url;style.dataset.slUiFontUsers='0';style.textContent=`@font-face{font-family:'Instrument Sans';src:url(${JSON.stringify(url)}) format('woff2');font-weight:400 700;font-style:normal;font-display:swap}`;head.append(style);}
 style.dataset.slUiFontUsers=String(Number(style.dataset.slUiFontUsers)+1);
 let released=false;
 return()=>{if(released)return;released=true;const users=Number(style.dataset.slUiFontUsers)-1;if(users<=0)style.remove();else style.dataset.slUiFontUsers=String(users);};
}
