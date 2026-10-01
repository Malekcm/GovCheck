/**
 * Capability library. `keywords` are the phrases discovery and scoring look for in
 * opportunity text (title, description, documents, requirements). The capability
 * name itself is always matched too. Users can add custom capabilities and edit keywords.
 */
export interface CapabilitySeed {
  slug: string;
  name: string;
  keywords?: string[];
  children?: CapabilitySeed[];
}

export interface CategorySeed {
  category: string;
  slug: string;
  items: CapabilitySeed[];
}

export const CAPABILITY_TAXONOMY: CategorySeed[] = [
  {
    category: 'Program / Project Management',
    slug: 'program-project-management',
    items: [
      { slug: 'program-management', name: 'Program Management', keywords: ['program management', 'program manager', 'program support', 'program management support'] },
      { slug: 'project-management', name: 'Project Management', keywords: ['project management', 'project manager', 'PMP', 'project schedule', 'integrated master schedule'] },
      { slug: 'pmo', name: 'PMO', keywords: ['PMO', 'program management office', 'project management office'] },
      { slug: 'epmo', name: 'EPMO', keywords: ['EPMO', 'enterprise program management office', 'enterprise project management'] },
      { slug: 'portfolio-management', name: 'Portfolio Management', keywords: ['portfolio management', 'IT portfolio', 'capital planning', 'CPIC'] },
      { slug: 'agile-delivery', name: 'Agile Delivery', keywords: ['agile', 'scrum', 'SAFe', 'kanban', 'sprint', 'scaled agile'] },
      { slug: 'waterfall-delivery', name: 'Waterfall Delivery', keywords: ['waterfall', 'SDLC', 'systems development life cycle'] },
      { slug: 'requirements-management', name: 'Requirements Management', keywords: ['requirements management', 'requirements gathering', 'requirements traceability', 'requirements analysis'] },
      { slug: 'business-analysis', name: 'Business Analysis', keywords: ['business analysis', 'business analyst', 'business process analysis', 'BPMN'] },
      { slug: 'process-improvement', name: 'Process Improvement', keywords: ['process improvement', 'lean six sigma', 'business process reengineering', 'continuous improvement', 'process optimization'] },
      { slug: 'strategic-planning', name: 'Strategic Planning', keywords: ['strategic planning', 'strategic plan', 'strategy development', 'roadmap'] },
      { slug: 'governance', name: 'Governance', keywords: ['governance', 'IT governance', 'governance framework', 'oversight'] },
      { slug: 'change-management', name: 'Change Management', keywords: ['organizational change management', 'change management', 'OCM', 'adoption'] },
      { slug: 'stakeholder-management', name: 'Stakeholder Management', keywords: ['stakeholder management', 'stakeholder engagement', 'stakeholder communication'] },
      { slug: 'acquisition-support', name: 'Acquisition Support', keywords: ['acquisition support', 'acquisition management', 'procurement support', 'acquisition planning'] },
      { slug: 'contract-support', name: 'Contract Support', keywords: ['contract support', 'contract administration', 'contracting support', 'COR support'] },
    ],
  },
  {
    category: 'Software Development',
    slug: 'software-development',
    items: [
      { slug: 'web-applications', name: 'Web Applications', keywords: ['web application', 'web applications', 'web portal', 'web-based application', 'website development'] },
      { slug: 'internal-business-applications', name: 'Internal Business Applications', keywords: ['business application', 'case management system', 'line of business application', 'custom application'] },
      { slug: 'front-end-development', name: 'Front-End Development', keywords: ['front-end', 'frontend', 'user interface development', 'HTML', 'CSS'] },
      { slug: 'back-end-development', name: 'Back-End Development', keywords: ['back-end', 'backend', 'server-side', 'microservices'] },
      { slug: 'full-stack-development', name: 'Full-Stack Development', keywords: ['full stack', 'full-stack', 'software development', 'software engineering', 'application development'] },
      { slug: 'react', name: 'React', keywords: ['React', 'React.js', 'ReactJS'] },
      { slug: 'typescript', name: 'TypeScript', keywords: ['TypeScript'] },
      { slug: 'javascript', name: 'JavaScript', keywords: ['JavaScript', 'Node.js', 'NodeJS'] },
      { slug: 'dotnet', name: '.NET', keywords: ['.NET', 'dotnet', 'C#', 'VB.NET'] },
      { slug: 'aspnet-core', name: 'ASP.NET Core', keywords: ['ASP.NET', 'ASP.NET Core', '.NET Core'] },
      { slug: 'python', name: 'Python', keywords: ['Python', 'Django', 'Flask', 'pandas'] },
      { slug: 'api-development', name: 'API Development', keywords: ['API development', 'API', 'APIs', 'application programming interface', 'web services'] },
      { slug: 'rest-apis', name: 'REST APIs', keywords: ['REST', 'RESTful', 'REST API'] },
      { slug: 'system-integration', name: 'System Integration', keywords: ['system integration', 'systems integration', 'integration services', 'interface development', 'interoperability'] },
      { slug: 'legacy-modernization', name: 'Legacy Modernization', keywords: ['legacy modernization', 'legacy system', 'mainframe migration', 'COBOL', 'legacy application'] },
      { slug: 'application-modernization', name: 'Application Modernization', keywords: ['application modernization', 'modernization', 'cloud migration', 'replatform', 're-architect'] },
      { slug: 'mobile-applications', name: 'Mobile Applications', keywords: ['mobile application', 'mobile app', 'iOS', 'Android'] },
    ],
  },
  {
    category: 'Data / Analytics',
    slug: 'data-analytics',
    items: [
      { slug: 'data-analytics', name: 'Data Analytics', keywords: ['data analytics', 'data analysis', 'analytics', 'data analyst', 'data science'] },
      { slug: 'business-intelligence', name: 'Business Intelligence', keywords: ['business intelligence', 'BI', 'BI tools', 'decision support'] },
      { slug: 'power-bi', name: 'Power BI', keywords: ['Power BI', 'PowerBI', 'DAX', 'Power Query'] },
      { slug: 'tableau', name: 'Tableau', keywords: ['Tableau'] },
      { slug: 'reporting-automation', name: 'Reporting Automation', keywords: ['reporting automation', 'automated reporting', 'automated reports', 'report automation'] },
      { slug: 'dashboard-development', name: 'Dashboard Development', keywords: ['dashboard', 'dashboards', 'data visualization', 'visualizations', 'scorecard'] },
      { slug: 'sql', name: 'SQL', keywords: ['SQL', 'T-SQL', 'PL/SQL', 'stored procedures'] },
      { slug: 'data-modeling', name: 'Data Modeling', keywords: ['data modeling', 'data model', 'dimensional model', 'star schema'] },
      { slug: 'data-warehousing', name: 'Data Warehousing', keywords: ['data warehouse', 'data warehousing', 'data mart', 'data lake', 'lakehouse'] },
      { slug: 'etl', name: 'ETL', keywords: ['ETL', 'ELT', 'data pipeline', 'SSIS', 'extract transform load'] },
      { slug: 'data-integration', name: 'Data Integration', keywords: ['data integration', 'data exchange', 'data sharing'] },
      { slug: 'data-migration', name: 'Data Migration', keywords: ['data migration', 'data conversion', 'migrate data'] },
      { slug: 'data-quality', name: 'Data Quality', keywords: ['data quality', 'data cleansing', 'data validation', 'master data'] },
      { slug: 'data-governance', name: 'Data Governance', keywords: ['data governance', 'data management', 'data stewardship', 'metadata management', 'data catalog'] },
      { slug: 'snowflake', name: 'Snowflake', keywords: ['Snowflake'] },
      { slug: 'sql-server', name: 'SQL Server', keywords: ['SQL Server', 'MS SQL', 'SSRS', 'SSAS'] },
      { slug: 'oracle', name: 'Oracle', keywords: ['Oracle database', 'Oracle'] },
    ],
  },
  {
    category: 'Microsoft / Automation',
    slug: 'microsoft-automation',
    items: [
      { slug: 'microsoft-365', name: 'Microsoft 365', keywords: ['Microsoft 365', 'Office 365', 'M365', 'O365', 'Microsoft Teams'] },
      { slug: 'sharepoint', name: 'SharePoint', keywords: ['SharePoint', 'SharePoint Online'] },
      { slug: 'power-apps', name: 'Power Apps', keywords: ['Power Apps', 'PowerApps', 'Power Platform', 'low-code', 'low code'] },
      { slug: 'power-automate', name: 'Power Automate', keywords: ['Power Automate', 'Microsoft Flow'] },
      { slug: 'workflow-automation', name: 'Workflow Automation', keywords: ['workflow automation', 'workflow', 'business process automation', 'RPA', 'robotic process automation'] },
      { slug: 'forms-automation', name: 'Forms Automation', keywords: ['forms automation', 'electronic forms', 'e-forms', 'digital forms'] },
      { slug: 'document-automation', name: 'Document Automation', keywords: ['document automation', 'document management', 'document generation', 'records management'] },
      { slug: 'excel-automation', name: 'Excel Automation', keywords: ['Excel', 'VBA', 'Excel macros', 'spreadsheet automation'] },
    ],
  },
  {
    category: 'UX / QA',
    slug: 'ux-qa',
    items: [
      { slug: 'user-experience', name: 'User Experience', keywords: ['user experience', 'UX', 'human-centered design', 'user research', 'usability'] },
      { slug: 'ui-design', name: 'UI Design', keywords: ['UI design', 'user interface design', 'visual design', 'design system', 'wireframes', 'prototyping'] },
      { slug: 'accessibility', name: 'Accessibility', keywords: ['accessibility', 'WCAG', 'accessible'] },
      { slug: 'section-508', name: 'Section 508', keywords: ['Section 508', '508 compliance', '508 compliant'] },
      { slug: 'functional-testing', name: 'Functional Testing', keywords: ['functional testing', 'system testing', 'integration testing'] },
      { slug: 'regression-testing', name: 'Regression Testing', keywords: ['regression testing', 'automated testing', 'test automation', 'Selenium'] },
      { slug: 'qa', name: 'QA', keywords: ['quality assurance', 'QA', 'software testing', 'testing services', 'IV&V', 'independent verification and validation'] },
      { slug: 'test-case-development', name: 'Test Case Development', keywords: ['test cases', 'test scripts', 'test plan'] },
      { slug: 'uat-support', name: 'UAT Support', keywords: ['UAT', 'user acceptance testing'] },
    ],
  },
  {
    category: 'Cloud / DevOps',
    slug: 'cloud-devops',
    items: [
      { slug: 'azure', name: 'Azure', keywords: ['Azure', 'Microsoft Azure', 'Azure Government'] },
      { slug: 'aws', name: 'AWS', keywords: ['AWS', 'Amazon Web Services', 'GovCloud'] },
      { slug: 'ci-cd', name: 'CI/CD', keywords: ['CI/CD', 'continuous integration', 'continuous delivery', 'continuous deployment', 'pipelines'] },
      { slug: 'devops', name: 'DevOps', keywords: ['DevOps', 'DevSecOps', 'site reliability'] },
      { slug: 'github', name: 'GitHub', keywords: ['GitHub', 'Git', 'GitLab'] },
      { slug: 'azure-devops', name: 'Azure DevOps', keywords: ['Azure DevOps', 'ADO', 'TFS'] },
      { slug: 'infrastructure-automation', name: 'Infrastructure Automation', keywords: ['infrastructure as code', 'Terraform', 'Ansible', 'infrastructure automation', 'IaC'] },
    ],
  },
  {
    category: 'Other Professional Services',
    slug: 'other-professional-services',
    items: [
      { slug: 'training', name: 'Training', keywords: ['training', 'training development', 'instructor-led', 'e-learning', 'curriculum'] },
      { slug: 'technical-documentation', name: 'Technical Documentation', keywords: ['technical documentation', 'technical writing', 'technical writer', 'user guides', 'documentation'] },
      { slug: 'sop-development', name: 'SOP Development', keywords: ['SOP', 'standard operating procedures', 'procedures development', 'policies and procedures'] },
      { slug: 'reporting-support', name: 'Reporting Support', keywords: ['reporting support', 'performance reporting', 'metrics reporting', 'data reporting'] },
      { slug: 'management-consulting', name: 'Management Consulting', keywords: ['management consulting', 'consulting services', 'advisory services', 'organizational assessment'] },
      { slug: 'technology-consulting', name: 'Technology Consulting', keywords: ['technology consulting', 'IT consulting', 'IT advisory', 'technology assessment', 'enterprise architecture'] },
      { slug: 'data-calls', name: 'Data Calls', keywords: ['data calls', 'data call', 'tasker', 'congressional inquiries'] },
      { slug: 'administrative-automation', name: 'Administrative Automation', keywords: ['administrative automation', 'administrative support', 'office automation'] },
    ],
  },
];

export const FEEDBACK_REASONS: { code: string; label: string; polarity: 'positive' | 'negative'; groups: string[] }[] = [
  { code: 'excellent_capability_fit', label: 'Excellent capability fit', polarity: 'positive', groups: ['cap', 'scope', 'comp:capability', 'comp:scope'] },
  { code: 'similar_past_performance', label: 'Similar past performance', polarity: 'positive', groups: ['comp:past_performance'] },
  { code: 'good_agency', label: 'Good agency', polarity: 'positive', groups: ['agency', 'subagency'] },
  { code: 'good_customer', label: 'Good customer', polarity: 'positive', groups: ['office', 'subagency'] },
  { code: 'good_contract_size', label: 'Good contract size', polarity: 'positive', groups: ['value'] },
  { code: 'good_set_aside', label: 'Good set-aside', polarity: 'positive', groups: ['setaside'] },
  { code: 'good_location', label: 'Good location', polarity: 'positive', groups: ['state'] },
  { code: 'good_timeline', label: 'Good timeline', polarity: 'positive', groups: ['comp:timeline', 'stage'] },
  { code: 'good_subcontract_opportunity', label: 'Good subcontract opportunity', polarity: 'positive', groups: ['class'] },
  { code: 'strategic_opportunity', label: 'Strategic opportunity', polarity: 'positive', groups: ['agency', 'subagency', 'naics4'] },
  { code: 'strong_margin_potential', label: 'Strong margin potential', polarity: 'positive', groups: ['value', 'pricing'] },
  { code: 'other_positive', label: 'Other', polarity: 'positive', groups: [] },
  { code: 'wrong_scope', label: 'Wrong scope', polarity: 'negative', groups: ['cap', 'scope', 'naics', 'naics4', 'psc2', 'comp:capability', 'comp:scope'] },
  { code: 'not_enough_experience', label: 'Not enough experience', polarity: 'negative', groups: ['cap', 'scope', 'comp:past_performance'] },
  { code: 'too_large', label: 'Too large', polarity: 'negative', groups: ['value'] },
  { code: 'too_small', label: 'Too small', polarity: 'negative', groups: ['value'] },
  { code: 'wrong_agency', label: 'Wrong agency', polarity: 'negative', groups: ['agency', 'subagency', 'office'] },
  { code: 'wrong_location', label: 'Wrong location', polarity: 'negative', groups: ['state'] },
  { code: 'too_much_travel', label: 'Too much travel', polarity: 'negative', groups: ['state', 'travel'] },
  { code: 'deadline_too_soon', label: 'Deadline too soon', polarity: 'negative', groups: ['comp:timeline'] },
  { code: 'requires_clearance', label: 'Requires clearance', polarity: 'negative', groups: ['clearance'] },
  { code: 'requires_certification', label: 'Requires certification', polarity: 'negative', groups: ['setaside', 'cert'] },
  { code: 'requires_contract_vehicle', label: 'Requires contract vehicle', polarity: 'negative', groups: ['vehicle'] },
  { code: 'set_aside_issue', label: 'Set-aside issue', polarity: 'negative', groups: ['setaside'] },
  { code: 'weak_past_performance', label: 'Weak past performance', polarity: 'negative', groups: ['comp:past_performance'] },
  { code: 'low_value', label: 'Low value', polarity: 'negative', groups: ['value'] },
  { code: 'too_competitive', label: 'Too competitive', polarity: 'negative', groups: ['setaside', 'stage'] },
  { code: 'strong_incumbent_concern', label: 'Strong incumbent concern', polarity: 'negative', groups: ['incumbent'] },
  { code: 'not_strategic', label: 'Not strategic', polarity: 'negative', groups: ['agency', 'naics4', 'class'] },
  { code: 'bad_timing', label: 'Bad timing', polarity: 'negative', groups: ['comp:timeline', 'stage'] },
  { code: 'other_negative', label: 'Other', polarity: 'negative', groups: [] },
];

export const SYSTEM_QUEUES: { slug: string; name: string; description: string; filters: Record<string, unknown>; sort?: string }[] = [
  { slug: 'new', name: 'New', description: 'Profiles first seen since your last visit.', filters: { newSinceVisit: true }, sort: 'newest' },
  { slug: 'high-match', name: 'High Match', description: 'Fit score 70 or above, still open or upcoming.', filters: { minFit: 70, openOnly: true }, sort: 'best' },
  { slug: 'needs-review', name: 'Needs Review', description: 'Relevant (fit ≥ 40), open, and not yet reviewed.', filters: { minFit: 40, decision: ['none'], openOnly: true }, sort: 'preference' },
  { slug: 'pursuing', name: 'Pursuing', description: '', filters: { decision: ['pursue'] }, sort: 'deadline' },
  { slug: 'interested', name: 'Interested', description: '', filters: { decision: ['interested'] }, sort: 'deadline' },
  { slug: 'watching', name: 'Watching', description: '', filters: { decision: ['watch'] }, sort: 'updated' },
  { slug: 'maybe', name: 'Maybe', description: '', filters: { decision: ['maybe'] }, sort: 'deadline' },
  { slug: 'passed', name: 'Passed', description: 'Pass and Not Relevant decisions.', filters: { decision: ['pass', 'not_relevant'] }, sort: 'updated' },
  { slug: 'forecasts', name: 'Forecasts', description: 'Pre-solicitation intelligence.', filters: { stage: ['forecast'] }, sort: 'best' },
  { slug: 'sources-sought', name: 'Sources Sought / RFI', description: '', filters: { stage: ['sources_sought', 'rfi'] }, sort: 'best' },
  { slug: 'rfp-rfq', name: 'RFP / RFQ', description: 'Active solicitations.', filters: { stage: ['solicitation', 'combined_synopsis'], openOnly: true }, sort: 'best' },
  { slug: 'subcontracts', name: 'Subcontracts', description: '', filters: { opportunityClass: ['subcontract'] }, sort: 'best' },
  { slug: 'grants', name: 'Grants', description: 'Shown when grants are enabled in the company profile.', filters: { opportunityClass: ['grant'] }, sort: 'best' },
  { slug: 'recompetes', name: 'Recompete Signals', description: 'Expiring contracts with no successor detected. NOT active solicitations.', filters: { recompete: true }, sort: 'best' },
  { slug: 'recently-updated', name: 'Recently Updated', description: 'Changed in the last 7 days.', filters: { changedWithinDays: 7 }, sort: 'updated' },
  { slug: 'due-soon', name: 'Due Soon', description: 'Responses due within 14 days.', filters: { dueWithinDays: 14 }, sort: 'deadline' },
  { slug: 'all', name: 'All', description: 'Everything accumulated.', filters: {}, sort: 'best' },
];
