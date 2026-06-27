(function () {
  // Mobile hamburger menu toggle
  var hamburger = document.querySelector('.nav-hamburger');
  var nav = document.querySelector('.nav');
  var mobileMenu = document.querySelector('.mobile-menu');
  var overlay = document.querySelector('.menu-overlay');
  function setMenu(open) {
    hamburger && hamburger.classList.toggle('open', open);
    nav && nav.classList.toggle('menu-open', open);
    mobileMenu && mobileMenu.classList.toggle('open', open);
    overlay && overlay.classList.toggle('open', open);
  }
  if (hamburger) {
    hamburger.addEventListener('click', function () {
      setMenu(!hamburger.classList.contains('open'));
    });
  }
  if (overlay) overlay.addEventListener('click', function () { setMenu(false); });
  document.querySelectorAll('.mobile-menu-link').forEach(function (a) {
    a.addEventListener('click', function () { setMenu(false); });
  });

  // Scroll progress bar
  var bar = document.getElementById('scroll-progress-bar');
  function updateProgress() {
    if (!bar) return;
    var total = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (total > 0 ? (window.scrollY / total) * 100 : 0) + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  updateProgress();

  // Back to top
  var backToTop = document.querySelector('.back-to-top');
  if (backToTop) {
    window.addEventListener('scroll', function () {
      backToTop.classList.toggle('visible', window.scrollY > 400);
    }, { passive: true });
    backToTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Fade-in reveal on scroll
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.05, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.fade-in').forEach(function (el) { io.observe(el); });
})();
