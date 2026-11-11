"use strict";
const form = document.getElementById("loginForm");
const password = document.getElementById("password");
const error = document.getElementById("loginError");
const submit = document.getElementById("loginSubmit");
document.getElementById("showPassword").addEventListener("click", event => {
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  event.currentTarget.textContent = visible ? "隐藏" : "显示";
  event.currentTarget.setAttribute("aria-pressed", String(visible));
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  submit.disabled = true; submit.textContent = "正在登录…"; error.hidden = true;
  try {
    const response = await fetch("/workbench/api/auth/login", {
      method:"POST", headers:{"Content-Type":"application/json","X-Workbench":"1"},
      body:JSON.stringify({username:form.elements.username.value.trim(),password:password.value})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "登录未成功，请检查用户名和密码");
    password.value = "";
    window.location.replace("/workbench/");
  } catch (problem) {
    error.textContent = problem.message === "Failed to fetch" ? "暂时无法连接工作台，请稍后重试。" : problem.message;
    error.hidden = false;
    submit.disabled = false; submit.textContent = "登录工作台 ↗";
  }
});
