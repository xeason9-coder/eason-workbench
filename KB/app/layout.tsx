import type {Metadata} from 'next';import './globals.css';
export const metadata:Metadata={title:'知识与内容工作台',description:'以知识为依据，协同研究、写作和检查，完成官网SEO文章。'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
