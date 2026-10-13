// Labelled set for calibrating the semantic-rescue threshold (L1.5). Every item
// is a posting whose TITLE fails the query's positive keywords, i.e. exactly the
// population rescue sees. `match: true` means a human would want it shown for the
// query (a generic title hiding the right work), `false` means a plausible
// near-miss or unrelated role. Consumed by scripts/calibrate-rescue.ts, and
// checked structurally by src/core/semantic-rescue.test.ts (every item must be
// a title-only L1 miss, or the calibration measures the wrong population).

import type { Criteria } from '../../src/core/filter';

export interface RescueFixtureItem {
  title: string;
  company: string;
  jd: string;
  match: boolean;
}

export interface RescueFixtureQuery {
  /** What the user typed. */
  query: string;
  /** The threshold is chosen on 'fit' queries and reported on 'holdout' queries, so
   *  the quoted numbers measure generalisation to searches it was not tuned on. */
  split: 'fit' | 'holdout';
  /** What nl-filter would plausibly derive from it. */
  criteria: Criteria;
  /** Postings that PASSED L1 on a title keyword for this query (one is deliberately
   *  a keyword false positive), the in-run reference set a centroid anchor uses. */
  survivors: Omit<RescueFixtureItem, 'match'>[];
  items: RescueFixtureItem[];
}

export const RESCUE_FIXTURES: RescueFixtureQuery[] = [
  {
    query: 'senior backend engineer, remote in Europe',
    split: 'fit',
    criteria: {
      title: {
        positive: ['backend engineer', 'backend developer', 'backend', 'back-end', 'server-side', 'python', 'golang', 'java'],
        negative: [],
      },
      seniority: { allowed: ['senior'] },
      location: { remote_required: true, allowed: ['europe'] },
    },
    survivors: [
      { title: 'Senior Backend Engineer', company: 'Ardent Cloud', jd: 'Design and build backend services in Go that power our public API. You will own database schemas in Postgres, message processing on Kafka and the reliability of what you ship. Remote within European time zones.' },
      { title: 'Backend Developer', company: 'Marlow Commerce', jd: 'Develop server-side features for our e-commerce platform in Java and Spring. Work includes REST APIs, SQL performance tuning, background jobs and integration with payment providers.' },
      { title: 'Python Backend Engineer', company: 'Quartz Mobility', jd: 'Build Python services using FastAPI that handle trip booking and pricing. You will design APIs, write tests, manage PostgreSQL migrations and deploy on Kubernetes.' },
      { title: 'Staff Backend Engineer', company: 'Ironbridge Security', jd: 'Lead the design of backend systems for our identity platform. You will define service boundaries, mentor engineers, and build high-throughput APIs and data stores.' },
      { title: 'Python Data Analyst', company: 'Marlow Commerce', jd: 'Analyse customer behaviour with Python and pandas, build notebooks and present insights to the commercial team. SQL and basic statistics are required.' },
    ],
    items: [
      { match: true, title: 'Software Engineer II', company: 'Lumen Pay', jd: 'You will design and run the payment authorization service that sits behind our public REST API. Day to day that means writing Go services, modelling data in Postgres, consuming Kafka topics, and keeping p99 latency low. You will own on-call for the services you ship and improve our observability.' },
      { match: true, title: 'Member of Technical Staff', company: 'Stratus Storage', jd: 'We are building a distributed object store. You will work on the server side of the system: replication, consensus, request routing and the gRPC APIs customers integrate with. Strong fundamentals in concurrency and databases matter more than any particular language, we use Rust and Go.' },
      { match: true, title: 'Software Developer', company: 'Northwind Logistics', jd: 'Join the team that maintains our fleet of Java Spring Boot microservices. You will build REST endpoints, write SQL against PostgreSQL, add message consumers on RabbitMQ and deploy to AWS using Terraform. There is no UI work in this role.' },
      { match: true, title: 'Engineer, Platform Services', company: 'Helix Health', jd: 'Our platform services team builds the internal APIs that every product team depends on: authentication, notifications, billing events and a job scheduler. You will write Python services, design database schemas, and improve reliability of queues and workers.' },
      { match: true, title: 'Application Developer', company: 'Brightwave Insurance', jd: 'Develop and maintain the Django and FastAPI services behind our policy administration system. Responsibilities include designing REST and GraphQL APIs, optimising slow queries, writing integration tests and handling data migrations in a large relational database.' },
      { match: true, title: 'Software Engineer, Ledger', company: 'Quill Finance', jd: 'The ledger team owns the double-entry accounting service that records every transaction. You will write Kotlin services using event sourcing, guarantee idempotency and consistency across services, and work closely with our data stores and APIs. Experience with high-throughput transactional systems is key.' },
      { match: true, title: 'Backendutvecklare', company: 'Nordlys Tech', jd: 'Vi soker en backendutvecklare som vill bygga skalbara API:er och tjanster i Java och Kotlin. Du kommer att arbeta med databaser, meddelandekoer och molninfrastruktur i AWS. Rollen ar fjarrbaserad inom Europa.' },
      { match: false, title: 'Frontend Engineer', company: 'Pixelforge', jd: 'Build the customer dashboard in React and TypeScript. You will own components in our design system, improve accessibility, write unit tests with Testing Library and collaborate with designers on interaction details. Some familiarity with a REST API is helpful but you will not write server code.' },
      { match: false, title: 'Data Engineer', company: 'Orbit Analytics', jd: 'Design and operate batch and streaming data pipelines using Airflow, Spark and dbt. You will model warehouse tables in Snowflake, enforce data quality checks and support analysts and data scientists who consume the datasets.' },
      { match: false, title: 'Sales Engineer', company: 'Cloudmere', jd: 'Partner with account executives to run technical discovery calls, deliver product demos and answer security questionnaires. You will explain our API and integration options to prospects, build proof of concept demos and gather product feedback for our roadmap.' },
      { match: false, title: 'QA Engineer', company: 'Tessera Games', jd: 'Own test automation for our web and mobile clients. You will write Selenium and Playwright suites, triage flaky tests, maintain the CI test pipeline and work with developers to reproduce defects found in exploratory testing.' },
      { match: false, title: 'iOS Engineer', company: 'Fieldnote', jd: 'Build and ship our iOS app in Swift and SwiftUI. You will implement offline sync on the device, work with Core Data, profile performance on older phones and prepare releases through TestFlight and the App Store.' },
      { match: false, title: 'Technical Support Engineer', company: 'Gridline Software', jd: 'Be the technical voice for our customers. You will investigate tickets, reproduce issues, read logs, and explain API behaviour to developers on the customer side. You escalate confirmed bugs to engineering with a clear reproduction.' },
      { match: false, title: 'Machine Learning Engineer', company: 'Vectorly', jd: 'Train and evaluate ranking and recommendation models using PyTorch. You will run experiments, build feature pipelines for training, and work with researchers to turn promising models into production-quality experiments.' },
      { match: false, title: 'Marketing Manager', company: 'Cloudmere', jd: 'Lead demand generation for our developer product. You will plan campaigns, manage the content calendar, run webinars, own the marketing budget and report on pipeline contribution to the leadership team.' },
      { match: false, title: 'Embedded Software Engineer', company: 'Tidewater Robotics', jd: 'Write real-time firmware in C for our motor controllers. You will bring up new boards, debug with oscilloscopes and logic analysers, implement CAN bus drivers and work with the mechanical team on actuator control loops.' },
    ],
  },
  {
    query: 'machine learning engineer, hybrid London',
    split: 'holdout',
    criteria: {
      title: {
        positive: ['machine learning engineer', 'ml engineer', 'machine learning', 'deep learning', 'mlops', 'pytorch'],
        negative: [],
      },
      location: { remote_required: false, allowed: ['uk', 'united kingdom'] },
    },
    survivors: [
      { title: 'Machine Learning Engineer', company: 'Cobalt Health', jd: 'Train and deploy models that predict patient no-shows. You will build training pipelines in PyTorch, evaluate models offline, and monitor them in production.' },
      { title: 'Senior ML Engineer', company: 'Aperture Retail', jd: 'Own demand forecasting models end to end: feature engineering, training, serving and monitoring. You will work with data scientists and platform engineers.' },
      { title: 'MLOps Engineer', company: 'Delta Freight', jd: 'Build the platform that trains and serves our machine learning models. You will own pipelines, model registry, feature store and automated retraining on Kubernetes.' },
      { title: 'Deep Learning Engineer', company: 'Lumina Vision', jd: 'Develop deep learning models for defect detection from images. You will experiment with architectures in PyTorch, optimise inference latency and ship models to edge devices.' },
      { title: 'Machine Learning Recruiter', company: 'Aperture Retail', jd: 'Hire machine learning talent for our growing data organisation. You will source candidates, run screens and manage the interview process with hiring managers.' },
    ],
    items: [
      { match: true, title: 'Software Engineer, Ranking', company: 'Marketlane', jd: 'You will train and ship the models that rank search results for millions of shoppers. Work includes building features, training gradient boosted trees and neural networks in PyTorch, running online experiments, and monitoring models in production for drift.' },
      { match: true, title: 'Member of Technical Staff', company: 'Parsec AI', jd: 'We are a small lab building language models. You will fine-tune and evaluate large models, write training and inference code, design evaluation harnesses and work on data curation for pretraining. Experience with distributed training on GPUs is a strong plus.' },
      { match: true, title: 'Research Engineer', company: 'Lumina Vision', jd: 'Implement and scale new computer vision architectures. You will reproduce papers, train convolutional and transformer models on large image datasets, optimise training throughput on multi-GPU clusters and hand models to the product team.' },
      { match: true, title: 'Applied Scientist', company: 'Kestrel Voice', jd: 'Own speech recognition quality for our assistant. You will design experiments, train acoustic and language models, analyse errors, and ship improvements through our model deployment pipeline. A PhD or equivalent practical experience in deep learning is expected.' },
      { match: true, title: 'AI Engineer', company: 'Brightpath Learning', jd: 'Build the intelligence behind our tutoring product: fine-tune models, design prompts and retrieval systems, create evaluation sets, and measure model quality with offline and online metrics. You will deploy models behind low latency inference services.' },
      { match: true, title: 'Software Engineer II, Fraud', company: 'Tallyhouse', jd: 'Develop the fraud detection models that score every card transaction in milliseconds. You will engineer features, train and calibrate classifiers, build the training data pipeline, and set up model monitoring and retraining jobs.' },
      { match: false, title: 'Data Analyst', company: 'Marketlane', jd: 'Turn raw data into insight for the commercial team. You will write SQL, build dashboards in Looker, run ad hoc analyses on conversion and retention, and present findings to stakeholders every week.' },
      { match: false, title: 'Data Engineer', company: 'Orbit Analytics', jd: 'Design and operate batch and streaming data pipelines using Airflow, Spark and dbt. You will model warehouse tables in Snowflake, enforce data quality checks and support analysts who consume the datasets.' },
      { match: false, title: 'Backend Engineer', company: 'Lumen Pay', jd: 'Build the payment authorization service behind our REST API. You will write Go services, model data in Postgres, consume Kafka topics and keep latency low, with responsibility for on-call for what you ship.' },
      { match: false, title: 'Product Manager, AI', company: 'Parsec AI', jd: 'Define the roadmap for our assistant features. You will write product specs, prioritise work with engineering and research, run customer interviews and track adoption metrics. You do not need to train models yourself.' },
      { match: false, title: 'Business Intelligence Developer', company: 'Tallyhouse', jd: 'Build and maintain reporting for finance and operations. You will develop semantic models in Power BI, write stored procedures in SQL Server and automate monthly reporting packs for the leadership team.' },
      { match: false, title: 'Frontend Engineer', company: 'Pixelforge', jd: 'Build the customer dashboard in React and TypeScript. You will own components in our design system, improve accessibility and collaborate with designers on interaction details.' },
      { match: false, title: 'Technical Recruiter', company: 'Kestrel Voice', jd: 'Partner with engineering managers to hire engineers and researchers. You will source candidates, run screening calls, coordinate interview loops and keep our applicant tracking system accurate.' },
      { match: false, title: 'DevOps Engineer', company: 'Gridline Software', jd: 'Run our Kubernetes clusters and CI pipelines. You will manage infrastructure as code with Terraform, improve deployment safety, respond to incidents and reduce cloud spend across environments.' },
      { match: false, title: 'Quantitative Analyst', company: 'Tallyhouse', jd: 'Price and risk-manage fixed income products. You will build pricing libraries in C++, calibrate yield curve models, back-test hedging strategies and explain risk to the trading desk.' },
    ],
  },
  {
    query: 'react frontend developer, remote',
    split: 'holdout',
    criteria: {
      title: {
        positive: ['react developer', 'frontend developer', 'frontend engineer', 'front-end developer', 'react', 'web developer'],
        negative: [],
      },
      location: { remote_required: true, allowed: [] },
    },
    survivors: [
      { title: 'Senior Frontend Engineer', company: 'Kite Travel', jd: 'Build our booking web app in React and TypeScript. You will own complex forms, state management and performance, and collaborate with designers on a shared component library.' },
      { title: 'React Developer', company: 'Ember Analytics', jd: 'Develop dashboards with React, charts and a REST API backend. You will write reusable components, unit tests, and improve accessibility and load times.' },
      { title: 'Frontend Developer', company: 'Willow Bank', jd: 'Implement responsive interfaces for our online banking portal using React and CSS. You will work closely with UX designers and QA to ship accessible, well tested features.' },
      { title: 'Web Developer', company: 'Harbor Hotels', jd: 'Maintain and build marketing and booking websites in JavaScript and React. You will optimise performance and SEO, and integrate with content management systems.' },
      { title: 'React Native Mobile Engineer', company: 'Kite Travel', jd: 'Build our cross-platform mobile app with React Native. You will write native bridges, handle push notifications and release to both app stores.' },
    ],
    items: [
      { match: true, title: 'Software Engineer II', company: 'Pixelforge', jd: 'You will build the customer-facing web app using TypeScript, Next.js and GraphQL. Responsibilities include building reusable UI components, improving page performance and accessibility, writing component tests and working with designers to ship polished interfaces in the browser.' },
      { match: true, title: 'UI Engineer', company: 'Tessera Games', jd: 'Own the interface layer of our web storefront. You will implement designs in HTML, CSS and TypeScript, manage client state, animate transitions, and keep Core Web Vitals healthy. You partner closely with product designers every day.' },
      { match: true, title: 'Creative Developer', company: 'Halcyon Studio', jd: 'Build immersive interactive websites for brand campaigns. You will work with Three.js, WebGL shaders and modern JavaScript frameworks to deliver smooth animation in the browser, and collaborate with art directors on motion details.' },
      { match: true, title: 'Software Developer, Web Platform', company: 'Fieldnote', jd: 'The web platform team builds the shared design system and the application shell for all of our products. You will write TypeScript components, maintain the build tooling, publish packages to the internal registry and help product teams adopt them.' },
      { match: true, title: 'Interface Developer', company: 'Brightwave Insurance', jd: 'Turn Figma designs into responsive, accessible web interfaces for our customer portal. Work includes writing semantic markup, styling with CSS modules, building forms with validation and testing across browsers and screen readers.' },
      { match: true, title: 'Member of Technical Staff, Product', company: 'Nimbus Notes', jd: 'We are a small team building a collaborative editor that runs in the browser. You will work on the editor surface, real-time cursors and rich text rendering in TypeScript, and care deeply about input latency and interaction polish.' },
      { match: false, title: 'Backend Engineer', company: 'Lumen Pay', jd: 'Build the payment authorization service behind our REST API. You will write Go services, model data in Postgres, consume Kafka topics and keep latency low, with responsibility for on-call for what you ship.' },
      { match: false, title: 'iOS Engineer', company: 'Fieldnote', jd: 'Build and ship our iOS app in Swift and SwiftUI. You will implement offline sync on the device, profile performance on older phones and prepare releases through TestFlight and the App Store.' },
      { match: false, title: 'Android Engineer', company: 'Kestrel Voice', jd: 'Develop our Android app in Kotlin with Jetpack Compose. You will integrate audio capture, handle background services and battery constraints, and release through the Play Console with staged rollouts.' },
      { match: false, title: 'Graphic Designer', company: 'Halcyon Studio', jd: 'Create brand identities, print collateral and social assets. You will work in Illustrator and Photoshop, prepare files for printers and keep a consistent visual language across campaigns.' },
      { match: false, title: 'Data Engineer', company: 'Orbit Analytics', jd: 'Design and operate batch and streaming data pipelines using Airflow, Spark and dbt. You will model warehouse tables in Snowflake and enforce data quality checks.' },
      { match: false, title: 'Sales Engineer', company: 'Cloudmere', jd: 'Partner with account executives to run technical discovery calls, deliver product demos and answer security questionnaires. You will build proof of concept demos and gather product feedback.' },
      { match: false, title: 'Site Reliability Engineer', company: 'Gridline Software', jd: 'Keep our services available. You will define service level objectives, run incident response, automate capacity planning and operate Kubernetes clusters across multiple regions.' },
      { match: false, title: 'UX Researcher', company: 'Nimbus Notes', jd: 'Plan and run qualitative research with users of our editor. You will conduct interviews and usability tests, synthesise findings and present recommendations to design and product.' },
      { match: false, title: 'Technical Writer', company: 'Gridline Software', jd: 'Write and maintain developer documentation, tutorials and API references. You will interview engineers, keep docs in sync with releases and improve information architecture of our docs site.' },
    ],
  },
  {
    query: 'product designer',
    split: 'fit',
    criteria: {
      title: {
        positive: ['product designer', 'ux designer', 'ui designer', 'ux', 'ui/ux'],
        negative: [],
      },
    },
    survivors: [
      { title: 'Senior Product Designer', company: 'Atlas Fintech', jd: 'Design intuitive experiences for our payments product. You will lead projects from discovery to launch, create flows and prototypes in Figma, and partner with product and engineering.' },
      { title: 'UX Designer', company: 'Willow Bank', jd: 'Design customer journeys for our banking app. You will run usability tests, build wireframes and prototypes, and hand over specifications to engineers.' },
      { title: 'Product Designer, Mobile', company: 'Quartz Mobility', jd: 'Own the design of our rider app. You will craft user flows and interface details in Figma, work with researchers, and collaborate daily with engineers.' },
      { title: 'UI Designer', company: 'Ember Analytics', jd: 'Design clean data-dense interfaces for our analytics tool. You will build components in Figma, maintain visual consistency and review implementation with developers.' },
      { title: 'UX Engineer, Hardware', company: 'Tidewater Robotics', jd: 'Prototype operator control panels with embedded displays. You will write firmware for touch interfaces and test usability with factory operators.' },
    ],
    items: [
      { match: true, title: 'Designer, Growth', company: 'Nimbus Notes', jd: 'Design the onboarding and upgrade flows that turn new sign-ups into paying teams. You will create wireframes and high-fidelity prototypes in Figma, run design critiques, partner with product managers and engineers, and measure the impact of your designs through experiments.' },
      { match: true, title: 'Experience Designer', company: 'Brightpath Learning', jd: 'Own the end-to-end learning experience of our mobile app. You will map user journeys, prototype interactions, conduct usability testing and deliver polished interface specifications to engineering in Figma.' },
      { match: true, title: 'Design Systems Lead', company: 'Pixelforge', jd: 'Lead our design system: visual components, patterns, tokens and documentation used by every product team. You will work with engineers to keep Figma and code in sync, and coach designers on consistent interface design.' },
      { match: true, title: 'Digital Designer', company: 'Fieldnote', jd: 'Design screens and flows for our field service app. You will take problems from discovery to shipped interface, craft clean layouts and interaction details in Figma, and validate designs with technicians who use the app.' },
      { match: true, title: 'Interaction Designer', company: 'Kestrel Voice', jd: 'Shape how people talk to and interact with our assistant across voice and screen. You will prototype conversation and visual flows, run research sessions and work side by side with product and engineering on the final interface.' },
      { match: true, title: 'Visual Designer, App', company: 'Tessera Games', jd: 'Craft the look and feel of our mobile app interface: layout, typography, iconography and motion. You will build components in Figma, maintain the visual language and review implementation with engineers.' },
      { match: false, title: 'Graphic Designer', company: 'Halcyon Studio', jd: 'Create brand identities, print collateral and social assets. You will work in Illustrator and Photoshop, prepare files for printers and keep a consistent visual language across campaigns.' },
      { match: false, title: 'Product Manager', company: 'Nimbus Notes', jd: 'Own the roadmap for our collaboration features. You will write product requirements, prioritise the backlog with engineering, talk to customers weekly and track adoption and retention metrics.' },
      { match: false, title: 'Frontend Engineer', company: 'Pixelforge', jd: 'Build the customer dashboard in React and TypeScript. You will own components in our design system, improve accessibility and write unit tests with Testing Library.' },
      { match: false, title: 'Design Researcher', company: 'Brightpath Learning', jd: 'Run qualitative and quantitative research on how learners use our product. You will recruit participants, conduct interviews, analyse survey data and present insights that shape product direction.' },
      { match: false, title: 'Interior Designer', company: 'Maple & Oak Studio', jd: 'Develop interior concepts for residential and hospitality projects. You will produce space plans, select materials and furnishings, prepare drawings in AutoCAD and coordinate with contractors on site.' },
      { match: false, title: 'Industrial Designer', company: 'Tidewater Robotics', jd: 'Design the physical form of our robots. You will sketch concepts, model parts in SolidWorks, prototype enclosures with 3D printing and work with manufacturing on tolerances and materials.' },
      { match: false, title: 'Content Writer', company: 'Cloudmere', jd: 'Write blog posts, case studies and email nurture sequences for our developer audience. You will research topics with engineers, edit freelance work and optimise content for search.' },
      { match: false, title: 'Brand Marketing Manager', company: 'Halcyon Studio', jd: 'Lead brand strategy and campaigns across channels. You will manage agencies, own the brand calendar and budget, and measure awareness with surveys and social metrics.' },
    ],
  },
  {
    query: 'data analyst',
    split: 'fit',
    criteria: {
      title: {
        positive: ['data analyst', 'business analyst', 'analytics', 'sql', 'bi analyst'],
        negative: [],
      },
    },
    survivors: [
      { title: 'Data Analyst', company: 'Marlow Commerce', jd: 'Analyse customer behaviour with SQL and Python, build Looker dashboards and present weekly insights to the commercial team. You will define metrics, run cohort analyses and partner with product managers on experiments.' },
      { title: 'Senior Data Analyst', company: 'Cobalt Health', jd: 'Own reporting for clinical operations. You will write complex SQL against our warehouse, build Tableau dashboards, and translate questions from operations leaders into clear analyses and recommendations.' },
      { title: 'Business Analyst', company: 'Willow Bank', jd: 'Gather requirements and analyse data for our lending products. You will build Excel and SQL models, document processes and report on conversion and risk metrics to stakeholders.' },
      { title: 'Product Analytics Lead', company: 'Kite Travel', jd: 'Lead analytics for the booking funnel. You will design experiments, write SQL, maintain event tracking definitions and coach the team on interpreting A/B test results.' },
      { title: 'SQL Report Developer', company: 'Harbor Hotels', jd: 'Develop and maintain operational reports in SQL Server and Power BI for revenue management. You will tune queries, validate numbers with finance and schedule automated report delivery.' },
    ],
    items: [
      { match: true, title: 'Insights Associate', company: 'Aperture Retail', jd: 'Turn raw sales and customer data into answers for merchandising. You will write SQL queries, build dashboards in Looker, run ad hoc analyses on basket size and retention, and present findings to buyers every week.' },
      { match: true, title: 'Reporting Specialist', company: 'Delta Freight', jd: 'Own the weekly and monthly performance reports for operations. You will pull data with SQL, clean it in Excel and Tableau, spot anomalies, and explain trends to regional managers in plain language.' },
      { match: true, title: 'Commercial Associate', company: 'Marlow Commerce', jd: 'Support pricing and promotions decisions with analysis. You will model price elasticity in Excel and SQL, build performance dashboards, and summarise recommendations for the commercial director.' },
      { match: true, title: 'Strategy and Operations Associate', company: 'Quartz Mobility', jd: 'Work with leadership on operational questions. You will analyse trip and driver data in SQL, build forecasting models in spreadsheets, and prepare clear charts and written recommendations for decision makers.' },
      { match: true, title: 'Growth Associate', company: 'Nimbus Notes', jd: 'Analyse the signup and activation funnel. You will query event data with SQL, size opportunities, evaluate A/B tests with the product team, and report results in dashboards and short written summaries.' },
      { match: true, title: 'Decision Support Specialist', company: 'Cobalt Health', jd: 'Provide data to hospital managers. You will write SQL queries, produce utilisation and waiting-time dashboards, check data quality with source system owners and explain findings to non-technical audiences.' },
      { match: false, title: 'Data Engineer', company: 'Orbit Analytics', jd: 'Design and operate batch and streaming data pipelines using Airflow, Spark and dbt. You will model warehouse tables in Snowflake, enforce data quality checks and own pipeline reliability.' },
      { match: false, title: 'Data Scientist', company: 'Vectorly', jd: 'Build predictive models for churn and recommendations. You will train and evaluate machine learning models in Python, design experiments and productionise models with the engineering team.' },
      { match: false, title: 'Backend Engineer', company: 'Lumen Pay', jd: 'Build the payment authorization service behind our REST API. You will write Go services, model data in Postgres, consume Kafka topics and keep latency low, with responsibility for on-call.' },
      { match: false, title: 'Financial Analyst', company: 'Tallyhouse', jd: 'Support monthly close and forecasting for the finance team. You will reconcile ledgers, build budget models in Excel, analyse variances against plan and prepare management accounts.' },
      { match: false, title: 'Marketing Manager', company: 'Cloudmere', jd: 'Lead demand generation for our developer product. You will plan campaigns, manage the content calendar, run webinars, own the marketing budget and report on pipeline contribution.' },
      { match: false, title: 'HR Business Partner', company: 'Ember Analytics', jd: 'Partner with leaders on hiring, performance and employee relations. You will advise managers, run calibration cycles, handle sensitive cases and improve people processes across the company.' },
      { match: false, title: 'Customer Support Specialist', company: 'Gridline Software', jd: 'Answer customer tickets by email and chat, troubleshoot account issues, document known problems and escalate bugs to engineering with a clear description of how to reproduce them.' },
      { match: false, title: 'Accountant', company: 'Maple and Oak Studio', jd: 'Maintain the general ledger, process accounts payable and receivable, prepare VAT returns and support the annual audit. Experience with Xero or similar accounting software is expected.' },
    ],
  },
  {
    query: 'account executive, SaaS',
    split: 'fit',
    criteria: {
      title: {
        positive: ['account executive', 'sales executive', 'enterprise sales', 'sales representative', 'sdr'],
        negative: [],
      },
    },
    survivors: [
      { title: 'Account Executive, Mid-Market', company: 'Cloudmere', jd: 'Own the full sales cycle for mid-market accounts. You will prospect, run discovery calls and demos, negotiate contracts and close deals against a quarterly quota, working with sales engineers and customer success.' },
      { title: 'Senior Account Executive', company: 'Gridline Software', jd: 'Close new enterprise logos for our observability platform. You will build pipeline with outbound and partners, lead multi-threaded deal cycles, forecast accurately and consistently hit a new business quota.' },
      { title: 'Enterprise Account Executive', company: 'Ironbridge Security', jd: 'Sell our security platform to large organisations. You will map buying committees, run executive briefings and proofs of value, negotiate pricing and own a territory quota.' },
      { title: 'Sales Executive', company: 'Halcyon Studio', jd: 'Win new clients for our agency services. You will qualify inbound leads, pitch to marketing leaders, prepare proposals and close contracts against monthly targets.' },
      { title: 'Inbound Sales Representative', company: 'Nimbus Notes', jd: 'Respond to inbound trial users and convert them to paid plans. You will run short demo calls, handle pricing questions, and log everything in the CRM against a monthly revenue goal.' },
    ],
    items: [
      { match: true, title: 'Business Development Manager', company: 'Brightwave Insurance', jd: 'Win new corporate clients for our insurance products. You will generate your own pipeline, run meetings with HR and finance leaders, prepare proposals, negotiate terms and close deals against an annual quota.' },
      { match: true, title: 'Territory Manager, DACH', company: 'Kestrel Voice', jd: 'Own revenue in the DACH region. You will prospect target accounts, run demos with local teams, work with partners, manage the pipeline in Salesforce and close new business each quarter.' },
      { match: true, title: 'Commercial Lead, SMB', company: 'Pixelforge', jd: 'Sell our design platform to small and medium businesses. You will manage a pipeline of inbound and outbound leads, run discovery calls and demos, handle negotiation and hit a quarterly bookings target.' },
      { match: true, title: 'New Business Manager', company: 'Fieldnote', jd: 'Win new customers for our field service software. You will research prospects, book meetings, deliver product demonstrations, write quotes and close deals with operations directors.' },
      { match: true, title: 'Revenue Partner', company: 'Atlas Fintech', jd: 'Drive new revenue with growth-stage companies. You will source and qualify opportunities, lead pricing and contract discussions, collaborate with solutions engineers and own a quota-carrying pipeline.' },
      { match: true, title: 'Growth Sales Specialist', company: 'Parsec AI', jd: 'Close self-serve expansion and new team deals. You will contact high-intent leads, run short demos, negotiate annual plans and keep the CRM accurate while working against a monthly quota.' },
      { match: false, title: 'Sales Engineer', company: 'Cloudmere', jd: 'Partner with account executives to run technical discovery calls, deliver product demos and answer security questionnaires. You will build proof of concept demos and gather product feedback.' },
      { match: false, title: 'Customer Success Manager', company: 'Gridline Software', jd: 'Own the relationship with existing customers after the sale. You will run onboarding, hold quarterly business reviews, drive adoption and renewals, and flag risks to the account team.' },
      { match: false, title: 'Sales Operations Analyst', company: 'Ember Analytics', jd: 'Support the sales team with data. You will maintain Salesforce reports, manage territory and quota assignments, build forecasting dashboards and improve the lead routing process.' },
      { match: false, title: 'Marketing Manager', company: 'Halcyon Studio', jd: 'Lead brand strategy and campaigns across channels. You will manage agencies, own the brand calendar and budget, and measure awareness with surveys and social metrics.' },
      { match: false, title: 'Technical Recruiter', company: 'Kestrel Voice', jd: 'Partner with engineering managers to hire engineers and researchers. You will source candidates, run screening calls, coordinate interview loops and keep our applicant tracking system accurate.' },
      { match: false, title: 'Retail Store Manager', company: 'Maple and Oak Studio', jd: 'Run a showroom day to day. You will manage a team of sales associates, handle customer complaints, oversee stock and cash handling, and deliver the store targets set by head office.' },
      { match: false, title: 'Backend Engineer', company: 'Lumen Pay', jd: 'Build the payment authorization service behind our REST API. You will write Go services, model data in Postgres and consume Kafka topics, with responsibility for on-call.' },
      { match: false, title: 'Customer Support Specialist', company: 'Nimbus Notes', jd: 'Answer customer tickets by email and chat, troubleshoot account issues, document known problems and escalate bugs to engineering with a clear description of how to reproduce them.' },
    ],
  },
  {
    query: 'devops engineer',
    split: 'holdout',
    criteria: {
      title: {
        positive: ['devops engineer', 'sre', 'site reliability', 'platform engineer', 'infrastructure engineer', 'kubernetes'],
        negative: [],
      },
    },
    survivors: [
      { title: 'DevOps Engineer', company: 'Ardent Cloud', jd: 'Automate our build and deployment pipelines, manage Kubernetes clusters on AWS with Terraform, and improve monitoring and incident response for the engineering organisation.' },
      { title: 'Senior Site Reliability Engineer', company: 'Kite Travel', jd: 'Define service level objectives, lead incident response, automate toil and operate our multi-region infrastructure. You will work with developers to make services observable and resilient.' },
      { title: 'Platform Engineer', company: 'Marlow Commerce', jd: 'Build the internal platform developers deploy on: CI pipelines, Kubernetes, secrets management and golden paths. You will treat engineers as customers and measure deployment speed and safety.' },
      { title: 'Infrastructure Engineer', company: 'Delta Freight', jd: 'Run our data centre and cloud infrastructure. You will manage Linux fleets, networking, backups and infrastructure as code, and handle on-call for production incidents.' },
      { title: 'Kubernetes Administrator', company: 'Willow Bank', jd: 'Operate and secure our Kubernetes clusters. You will manage upgrades, ingress and policies, tune resource usage, and support application teams onboarding to the platform.' },
    ],
    items: [
      { match: true, title: 'Software Engineer, Infrastructure', company: 'Stratus Storage', jd: 'Own the systems that run our services in production. You will write Go tooling for deployments, manage Kubernetes and Terraform, improve observability and carry on-call for the platform.' },
      { match: true, title: 'Systems Engineer', company: 'Tidewater Robotics', jd: 'Manage our Linux servers and build servers. You will automate provisioning with Ansible and Terraform, maintain CI runners and artifact storage, and respond to production alerts.' },
      { match: true, title: 'Cloud Engineer', company: 'Brightpath Learning', jd: 'Design and operate our AWS environment. You will write infrastructure as code, manage networking, IAM and container orchestration, cut cloud costs and support developers shipping services.' },
      { match: true, title: 'Production Engineer', company: 'Quartz Mobility', jd: 'Keep the ride-matching services reliable. You will define alerts, run incident reviews, automate failovers and capacity planning, and write code to remove manual operations work.' },
      { match: true, title: 'Release Engineer', company: 'Tessera Games', jd: 'Own how our software ships. You will maintain CI and CD pipelines, build tooling for versioning and rollbacks, manage container registries and make deployments boring and safe.' },
      { match: true, title: 'Member of Technical Staff, Reliability', company: 'Parsec AI', jd: 'Make our training and inference clusters dependable. You will operate GPU infrastructure on Kubernetes, build monitoring, automate recovery from failed nodes and respond to incidents.' },
      { match: false, title: 'Backend Engineer', company: 'Lumen Pay', jd: 'Build the payment authorization service behind our REST API. You will write Go services, model data in Postgres and consume Kafka topics, with responsibility for on-call.' },
      { match: false, title: 'Frontend Engineer', company: 'Pixelforge', jd: 'Build the customer dashboard in React and TypeScript. You will own components in our design system, improve accessibility and write unit tests with Testing Library.' },
      { match: false, title: 'Security Analyst', company: 'Ironbridge Security', jd: 'Monitor alerts from our security tooling, triage suspicious activity, investigate incidents and write detection rules. You will report findings to the security lead and help with audits.' },
      { match: false, title: 'IT Support Technician', company: 'Harbor Hotels', jd: 'Support staff with laptops, accounts and printers. You will set up new starters, reset passwords, manage the helpdesk queue and keep the asset register up to date.' },
      { match: false, title: 'Data Engineer', company: 'Orbit Analytics', jd: 'Design and operate batch and streaming data pipelines using Airflow, Spark and dbt. You will model warehouse tables in Snowflake and enforce data quality checks.' },
      { match: false, title: 'Network Engineer', company: 'Gridline Software', jd: 'Design and maintain office and data centre networks. You will configure switches, routers and firewalls, plan upgrades, troubleshoot connectivity and document the network.' },
      { match: false, title: 'Solutions Architect', company: 'Cloudmere', jd: 'Work with prospects to design solutions on our platform. You will run architecture workshops, produce diagrams and proposals, and support the sales team through technical evaluations.' },
      { match: false, title: 'Mechanical Engineer', company: 'Tidewater Robotics', jd: 'Design robot chassis and actuator mounts in SolidWorks. You will run tolerance analyses, prototype parts, test them with the lab and work with suppliers on manufacturing.' },
    ],
  },
  {
    query: 'product manager',
    split: 'holdout',
    criteria: {
      title: {
        positive: ['product manager', 'product owner', 'technical product manager', 'group product manager'],
        negative: [],
      },
    },
    survivors: [
      { title: 'Product Manager', company: 'Atlas Fintech', jd: 'Own the roadmap for our payments product. You will talk to customers weekly, write clear specs, prioritise with engineering and design, and track adoption and revenue metrics after launch.' },
      { title: 'Senior Product Manager', company: 'Kite Travel', jd: 'Lead product strategy for booking and search. You will define the vision, set goals, run experiments with engineering and analytics, and align stakeholders across the business.' },
      { title: 'Technical Product Manager', company: 'Ardent Cloud', jd: 'Own our public API and developer experience. You will talk with integrating engineers, write technical requirements, plan versions and deprecations, and work with engineering on delivery.' },
      { title: 'Product Owner', company: 'Willow Bank', jd: 'Act as product owner for the mobile banking team. You will maintain the backlog, write user stories with acceptance criteria, run sprint reviews and decide scope trade-offs.' },
      { title: 'Group Product Manager', company: 'Nimbus Notes', jd: 'Lead a team of product managers across collaboration features. You will set the strategy, coach your managers, review roadmaps and represent product in executive planning.' },
    ],
    items: [
      { match: true, title: 'Product Strategy Lead', company: 'Quartz Mobility', jd: 'Decide what we build next for riders. You will analyse usage and market data, interview users, write product requirements, prioritise the roadmap with design and engineering and own launch outcomes.' },
      { match: true, title: 'Business Lead, Mobile', company: 'Brightpath Learning', jd: 'Own the mobile learning product end to end. You will set goals, define features, work daily with engineers and designers, run experiments and report growth and engagement results to leadership.' },
      { match: true, title: 'Feature Owner, Checkout', company: 'Marlow Commerce', jd: 'Own the checkout experience. You will study conversion data, interview shoppers, write specifications, prioritise improvements with engineering and measure the impact of each release.' },
      { match: true, title: 'Associate Director, Product', company: 'Cobalt Health', jd: 'Lead product for our clinician tools. You will define the roadmap, prioritise requests from hospitals, partner with engineering on delivery and manage relationships with clinical stakeholders.' },
      { match: true, title: 'Product Lead, Growth', company: 'Parsec AI', jd: 'Own acquisition and activation. You will define the growth strategy, write requirements for experiments, work with engineering and design to ship them and report on funnel metrics.' },
      { match: true, title: 'Head of Payments Product', company: 'Lumen Pay', jd: 'Lead the product direction for payments. You will own the roadmap, talk with merchants and partners, make prioritisation calls with engineering and drive launches across markets.' },
      { match: false, title: 'Project Manager', company: 'Delta Freight', jd: 'Plan and deliver warehouse automation projects. You will manage schedules, budgets and contractors, run weekly status meetings, track risks and report progress to the steering committee.' },
      { match: false, title: 'Program Manager, Operations', company: 'Harbor Hotels', jd: 'Coordinate cross-team operational programmes. You will track milestones across departments, run reviews, manage dependencies and keep leadership informed of progress and blockers.' },
      { match: false, title: 'Product Designer', company: 'Pixelforge', jd: 'Design flows and interfaces for our dashboard. You will create wireframes and prototypes in Figma, run usability tests and hand off specifications to engineers.' },
      { match: false, title: 'Product Marketing Manager', company: 'Cloudmere', jd: 'Own positioning and launch messaging for our products. You will write copy, enable sales, research competitors and coordinate launches with the marketing team.' },
      { match: false, title: 'Engineering Manager', company: 'Gridline Software', jd: 'Lead a team of backend engineers. You will hire, coach and review performance, plan sprints with product, remove blockers and keep delivery and quality on track.' },
      { match: false, title: 'Scrum Master', company: 'Willow Bank', jd: 'Facilitate agile ceremonies for two delivery teams. You will run stand-ups and retrospectives, remove impediments, track velocity and coach teams on agile practices.' },
      { match: false, title: 'Business Analyst', company: 'Marlow Commerce', jd: 'Gather requirements and analyse data for our lending products. You will build Excel and SQL models, document processes and report on conversion and risk metrics.' },
      { match: false, title: 'Backend Engineer', company: 'Lumen Pay', jd: 'Build the payment authorization service behind our REST API. You will write Go services, model data in Postgres and consume Kafka topics, with responsibility for on-call.' },
    ],
  },
];
