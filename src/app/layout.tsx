import type { Metadata, Viewport } from "next";
import { Archivo, Big_Shoulders, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const cartaz = Big_Shoulders({ variable: "--fonte-cartaz", subsets: ["latin"], weight: ["700", "800", "900"] });
const texto = Archivo({ variable: "--fonte-texto", subsets: ["latin"] });
const mono = IBM_Plex_Mono({ variable: "--fonte-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "Lia Brasa & Banda Cometa · Turnê Cais · Último Ingresso",
  description:
    "Ingressos para Lia Brasa & Banda Cometa na Arena Mangue, em Recife. Escolha seu lugar no mapa e reserve por alguns segundos antes de confirmar.",
};

export const viewport: Viewport = {
  themeColor: "#1c1730",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${cartaz.variable} ${texto.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
