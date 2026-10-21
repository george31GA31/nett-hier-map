(() => {
  "use strict";
  const carousel = document.querySelector(".sticker-carousel");
  if (!carousel) return;
  const slides = Array.from(carousel.querySelectorAll("[data-sticker-slide]"));
  const descriptions = Array.from(carousel.querySelectorAll("[data-sticker-description]"));
  const position = document.getElementById("stickerPosition");
  let current = 0;
  function show(index) {
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => { slide.hidden = i !== current; });
    descriptions.forEach((description, i) => { description.hidden = i !== current; });
    position.textContent = (current + 1) + " of " + slides.length + " · " + slides[current].querySelector("figcaption").textContent;
  }
  document.getElementById("stickerPrevious").addEventListener("click", () => show(current - 1));
  document.getElementById("stickerNext").addEventListener("click", () => show(current + 1));
  carousel.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    show(current + (event.key === "ArrowRight" ? 1 : -1));
  });
})();

// Measured artwork bounds in source pixels: original WebPs have opaque white
// margins, so alpha-only cropping or identical <img> widths cannot normalize them.
(() => {
  const crops = [[104,26,684,380],[105,26,683,380],[0,0,1077,1076],[44,0,912,999],[0,0,691,385]];
  document.querySelectorAll('[data-sticker-slide]').forEach((slide,index)=>{
    const img=slide.querySelector('img');const stage=document.createElement('span');stage.className='sticker-artwork';
    img.before(stage);stage.append(img);
    const normalize=()=>{
      const canvas=document.createElement('canvas');canvas.width=720;canvas.height=720;
      canvas.setAttribute('role','img');canvas.setAttribute('aria-label',img.alt);
      const [x,y,w,h]=crops[index];const scale=700/Math.max(w,h);
      canvas.getContext('2d').drawImage(img,x,y,w,h,(720-w*scale)/2,(720-h*scale)/2,w*scale,h*scale);
      stage.replaceChildren(canvas);
    };
    if(img.complete&&img.naturalWidth)normalize();else img.addEventListener('load',normalize,{once:true});
  });
})();
