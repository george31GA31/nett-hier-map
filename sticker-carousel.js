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
