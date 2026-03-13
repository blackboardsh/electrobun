module.exports = {
  content: [],
  theme: {
    extend: {
      animation: {
        sidesSlideIn: "sidesSlideIn 400ms both",
        sidesSlideOut: "sidesSlideOut 400ms both",
        endsSlideIn: "endsSlideIn 400ms both",
        endsSlideOut: "endsSlideOut 400ms both",
      },
      keyframes: {
        sidesSlideIn: {
          "0%": { width: "0px" },
          "100%": { width: "20px" },
        },
        sidesSlideOut: {
          "0%": { width: "20px" },
          "100%": { width: "0px" },
        },
        endsSlideIn: {
          "0%": { height: "0px" },
          "100%": { height: "20px" },
        },
        endsSlideOut: {
          "0%": { height: "20px" },
          "100%": { height: "0px" },
        },
      },
    },
  },
  plugins: [],
};
