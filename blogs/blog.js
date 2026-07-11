(function () {
  // Sign In button: countdown cycle animation (Sign In → X days → GATE → repeat)
  function daysUntilFeb1() {
    var now = new Date();
    var year = now.getFullYear();
    var feb1 = new Date(year, 1, 1); feb1.setHours(0,0,0,0);
    var mar1 = new Date(year, 2, 1); mar1.setHours(0,0,0,0);
    if (now < feb1) return Math.max(1, Math.ceil((feb1 - now) / 864e5));
    if (now < mar1) return null;
    var next = new Date(year + 1, 1, 1); next.setHours(0,0,0,0);
    return Math.max(1, Math.ceil((next - now) / 864e5));
  }
  var signinBtn = document.getElementById('blog-signin-btn');
  var daysSpan  = document.getElementById('blog-signin-days');
  var gateSpan  = document.getElementById('blog-signin-gate');
  var signinDefault = signinBtn && signinBtn.querySelector('.swap-default');
  if (signinBtn && daysSpan) {
    var daysLeft = daysUntilFeb1();
    if (daysLeft !== null) daysSpan.textContent = daysLeft + ' days';
    var phase = 0, timer = null;
    var T = '.32s cubic-bezier(.16,1,.3,1)';
    function applyPhase(p) {
      phase = p;
      // swap-default
      signinDefault.style.transform = p === 0 ? 'none'             : 'translateY(-100%)';
      signinDefault.style.opacity   = p === 0 ? '1'                : '0';
      signinDefault.style.transition = 'transform ' + T + ', opacity .24s ease';
      // days span
      daysSpan.style.transform  = p === 1 ? 'translateY(0)'   : 'translateY(100%)';
      daysSpan.style.opacity    = p === 1 ? '1'               : '0';
      daysSpan.style.transition = 'transform ' + T + ', opacity .24s ease';
      // gate span
      gateSpan.style.transform  = p === 2 ? 'translateY(0)'   : 'translateY(100%)';
      gateSpan.style.opacity    = p === 2 ? '1'               : '0';
      gateSpan.style.transition = 'transform ' + T + ', opacity .24s ease';
      // expand button on phases 1 & 2
      if (daysLeft !== null) {
        signinBtn.classList.toggle('signin-active', p > 0);
      }
    }
    function startCycle(e) {
      if (!daysLeft) return;
      var btn = e.currentTarget;
      var navInner = document.querySelector('.nav-links');
      if (navInner) {
        var avail = btn.getBoundingClientRect().left - navInner.getBoundingClientRect().right;
        if (avail < 36) return;
      }
      var phases = [0, 1, 2];
      var i = 1;
      applyPhase(phases[i]);
      clearInterval(timer);
      timer = setInterval(function () {
        i++;
        if (i >= phases.length) { i = 0; applyPhase(0); clearInterval(timer); timer = null; return; }
        applyPhase(phases[i]);
      }, 550);
    }
    function stopCycle() {
      clearInterval(timer); timer = null;
      applyPhase(0);
    }
    signinBtn.addEventListener('mouseenter', startCycle);
    signinBtn.addEventListener('mouseleave', stopCycle);
  }

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
