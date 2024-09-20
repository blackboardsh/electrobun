import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";

export default function Home(): JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={`${siteConfig.title}`} description="Electrobun">
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignSelf: "center",
          width: "100vw",
          background: "#111",
        }}
      >
        <div
          style={{
            alignSelf: "center",
            textAlign: "center",

            color: "#fefefe",
            padding: 20,
            maxWidth: 800,
          }}
        >
          <h1 style={{ fontSize: "4rem" }}>Electrobun</h1>
          <div style={{}}>
            <p>
              Electrobun aims to be a complete solution-in-a-box for building,
              updating, and shipping ultra fast, tiny, and cross-platform
              desktop applications written in Typescript.
            </p>
            <img src="/img/electrobun-logo-256.png"></img>
            <p>
              Under the hood it uses bun to execute the main process and to
              bundle webview Typescript, and has native bindings written in zig.
            </p>
          </div>
          <hr style={{ margin: "35px 0" }} />
          <h2>Install Electrobun</h2>
          <div
            style={{
              display: "flex",
              border: "4px solid #e263a9",
              borderRadius: 8,
              padding: 8,
              background: "#000",
              fontSize: 20,
              fontWeight: "bold",
              width: 300,
              alignSelf: "center",
              margin: "auto",
            }}
          >
            <span style={{ color: "#777", padding: "0 8px" }}>$</span>
            <span style={{ color: "#aaa" }}>bun install electrobun</span>
          </div>
          <hr style={{ margin: "35px 0" }} />
          <div
            style={{
              display: "flex",
              margin: "auto",
              textAlign: "left",
              flexWrap: "wrap",
              justifyContent: "space-evenly",
            }}
          >
            <div
              style={{
                minWidth: 100,
                maxWidth: 350,
                padding: 20,
                border: "2px solid black",
              }}
            >
              <h3>Typescript</h3>
              <p>
                Write Typescript for the main process and webviews without
                having to think about it. One language, no hassle.
              </p>
            </div>

            <div
              style={{
                minWidth: 100,
                maxWidth: 350,
                padding: 20,
                border: "2px solid black",
              }}
            >
              <h3>Fast</h3>
              <p>
                Security and Performance with isolation between the main and
                webview processes and fast, typed, easy to implement RPC between
                them.
              </p>
            </div>

            <div
              style={{
                minWidth: 100,
                maxWidth: 350,
                padding: 20,
                border: "2px solid black",
              }}
            >
              <h3>Tiny</h3>
              <p>
                Small self-extracting app bundles ~12MB and tiny app updates as
                small as 4KB. Ship often while saving bandwidth costs.
              </p>
            </div>

            <div
              style={{
                minWidth: 100,
                maxWidth: 350,
                padding: 20,
                border: "2px solid black",
              }}
            >
              <h3>Batteries</h3>
              <p>
                Everything you need in one tightly integrated workflow to start
                writing code in 5 minutes and distribute in 10.
              </p>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}
