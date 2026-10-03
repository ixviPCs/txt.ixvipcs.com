(() => {
  const phoneUserAgent = /Android.*Mobile|iPhone|iPod|IEMobile|Opera Mini|Windows Phone/i.test(navigator.userAgent);
  if (navigator.userAgentData?.mobile || phoneUserAgent) location.replace("/mobile.html");
})();
