window.__ModuleLoader__.load({
  id: "dsh-rollover",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;

    // 设置面板：iframe 嵌 host 的 /rollover（页面逻辑只有一份）
    function RolloverPanel() {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8, padding: "2px 2px 8px" } },
        h("iframe", {
          src: "/rollover",
          title: "滚段",
          style: {
            width: "100%",
            height: "calc(100vh - 240px)",
            minHeight: "420px",
            border: "0",
            borderRadius: "12px",
            background: "#0f1216",
            colorScheme: "dark"
          }
        })
      );
    }

    exports.name = "dsh-rollover";
    exports.inject = ["slots"];

    exports.apply = function apply(ctx) {
      const registerSection = () =>
        ctx.slots.register(
          { name: "settings.section", id: "rollover", order: 61, label: () => "上下文滚段" },
          () => h(RolloverPanel, {})
        );
      if (typeof ctx.slots.inject === "function") {
        ctx.slots.inject("settings.section", () => {
          const off = registerSection();
          return typeof off === "function" ? off : undefined;
        });
      } else {
        registerSection();
      }
    };

    return module.exports;
  }
});
