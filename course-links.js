// Links from schedule tasks to the matching lesson on the LMS
// (learn.taai.live). Keyed batch -> subject -> exact task_text, so the task
// text itself (which task_progress is keyed on) never has to change.
// Each link opens the lesson the task's range STARTS with: a lesson titled
// "Lecture N" when one exists for "Lec N" (exercises sit between lectures);
// in modules with no "Lecture N" titles (Counting, Basic Prob, Sampling, ...)
// the Nth VIDEO in that module's list (PDFs - notes, homework, corrections -
// are not lectures and are never counted). LA links are all title-matched.
//
// Built 2026-10-02 from the GATE 2027 bundle (https://learn.taai.live/learn/batch/GATE-2027/content):
// Linear Algebra, Probability and Statistics courses, plus the quizzes in
// "GATE DA Maths Practice Quizzes -TAAI" (seo Python---DSA-Question-Bank, a
// private course: logged out it shows "private course", enrolled students get in).
// Test links come later.
// (Learnyst's ShowProductSyllabus response: section + lesson ids). Lesson
// URL shape: /learn/home/GATE-2027/<course-seo>/section/<sectionId>/lesson/<lessonId>.
// If a schedule is reloaded with different task wording, update the keys
// here too or that task simply shows as plain text again.
window.SCHEDULE_TASK_LINKS = {
  D: {
    "Linear Algebra": {
      // Basics of Linear Algebra & System of linear Equations / Lecture 1
      "Mod 1: Lec 1 to 5": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/605683/lesson/3783559',
      // Basics of Linear Algebra & System of linear Equations / Lecture 6
      "Mod 1: Lec 6 to 10 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/605683/lesson/3783695',
      // Matrix Algebra / Basics of Matrix Algebra
      "Mod 2: All 6 Lessons (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/606888/lesson/3791650',
      // Vector Space / Basics
      "Mod 3: Basics to Prac 1": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/610876/lesson/3817485',
      // Vector Space / Four Fundamental Subspaces
      "Mod 3: Subspaces to dim (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/610876/lesson/3826411',
      // Determinant / Lecture 1
      "Mod 4 (Det) & Mod 5: Lec 1-2": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/617118/lesson/3865493',
      // Projection / Lecture 3
      "Mod 5: Proj Lec 3-5 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/617121/lesson/3866230',
      // Eigen Value and Eigen Vector / Basics
      "Mod 6: Eigen Basics to Diag": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/618712/lesson/3868530',
      // Eigen Value and Eigen Vector / Rank vs Eigen values
      "Mod 6: Rank to Prac 2": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/618712/lesson/3886019',
      // Eigen Value and Eigen Vector / Similar matrices
      "Mod 6: Similar to Pos Def (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/618712/lesson/3892215',
      // SVD / Introduction to SVD - I
      "Mod 7: SVD Intro to Examples": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/622425/lesson/3892954',
      // SVD / Imp Properties on SVD
      "Mod 7: Imp Prop to HW 2": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/622425/lesson/3895896',
      // SVD / Vector and Matrix Norms
      "Mod 7: Norms to Low Rank (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/622425/lesson/4909102',
      // Remaining Concepts / Partition Matrix and Quadratic Form -I
      "Mod 8: Remaining Concepts (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Linear-Algebra--Mathematics-/section/628630/lesson/3938600',
    },
    "Probability": {
      // Counting / Why do we need counting ?
      "Mod 1: Counting Lec 1-5": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/624017/lesson/3901884',
      // Counting / Practice Problems - III
      "Mod 1: Counting Lec 6-10": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/624017/lesson/3933701',
      // Counting / Grouping & Distribution -II
      "Mod 1: Counting Lec 11-14 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/624017/lesson/3933818',
      // Basic Probability / Basics - 1
      "Mod 2: Basic Prob Lec 1-6": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/629214/lesson/3970233',
      // Basic Probability / Conditional Probability - III
      "Mod 2: Basic Prob Lec 7-12 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/629214/lesson/3972311',
      // Random Variable / Defining Random Variable
      "Mod 3: Defining RV to Cont RV 1": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/640484/lesson/5266704',
      // Random Variable / Continuous Random Variable - 2
      "Mod 3: Cont RV 2 to Median": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/640484/lesson/5278220',
      // Random Variable / Bivariate Random Variable - I
      "Mod 3: Bivariate 1, 2, Prac 1": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/640484/lesson/3998196',
      // Random Variable / Bivariate Random Variable - III
      "Mod 3: Bivariate 3, 4, Prac 2": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/640484/lesson/3998199',
      // Random Variable / Practice Problems - III
      "Mod 3: Prac 3-5, HW (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/640484/lesson/5084522',
      // Expectation and Variance / Lecture 1
      "Mod 4: Exp/Var Lec 1-5": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/641642/lesson/3998204',
      // Covariance and Correlation / Lecture 1
      "Mod 5: Covariance Lec 1-6 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/641645/lesson/3998214',
      // Special Random Variables / Lecture 1
      "Mod 6: Special RV Lec 1-6": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/641647/lesson/3998221',
      // Special Random Variables / Lecture 7
      "Mod 6: Special RV Lec 7-13 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/641647/lesson/4018777',
      // Conditional Expectation and Variance / Lecture 1
      "Mod 7: Cond Exp Lec 1-6": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/641643/lesson/3998208',
      // Conditional Expectation and Variance / Lecture 5
      "Mod 7: Cond Exp Lec 7-13 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Probability/section/641643/lesson/4077432',
    },
    "Statistics": {
      // Sampling Distribution / Building intuition-I
      "Mod 1: Sampling Lec 1-5": 'https://learn.taai.live/learn/home/GATE-2027/Statistics/section/624022/lesson/3901902',
      // Sampling Distribution / Central Limit Theorem
      "Mod 1: Sampling Lec 6-11 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Statistics/section/624022/lesson/4234625',
      // Parameter estimation / Point estimation-I
      "Mod 2: Estimation Lec 1-6": 'https://learn.taai.live/learn/home/GATE-2027/Statistics/section/674931/lesson/4241901',
      // Parameter estimation / Confidence Interval -III
      "Mod 2: Estimation Lec 7-11": 'https://learn.taai.live/learn/home/GATE-2027/Statistics/section/674931/lesson/4258780',
      // Parameter estimation / Practice Problems - II
      "Mod 2: Estimation 12-16 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Statistics/section/674931/lesson/4260548',
      // Hypothesis Testing / Introduction -I
      "Mod 3: Hypothesis Lec 1-6": 'https://learn.taai.live/learn/home/GATE-2027/Statistics/section/677339/lesson/4291168',
      // Hypothesis Testing / Examples
      "Mod 3: Hypothesis Lec 7-11": 'https://learn.taai.live/learn/home/GATE-2027/Statistics/section/677339/lesson/4303621',
      // Hypothesis Testing / Z test of proportion
      "Mod 3: Hypothesis 12-17 (Done)": 'https://learn.taai.live/learn/home/GATE-2027/Statistics/section/677339/lesson/4304033',
    },
    "Quiz & Test Series": {
      // Linear Algebra / Basics of Linear Algebra and System of Linear Equations
      "LA Quiz 1 (Basics)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4148704',
      // Linear Algebra / Matrix Algebra and LU decomposition
      "LA Quiz 2 (Matrix Algebra)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4738731',
      // Linear Algebra / Vector Spaces and subspaces
      "LA Quiz 3 (Vector Space)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4740060',
      // Linear Algebra / Module 1,2,3 Cumulative quiz
      "LA Quiz 4 (Cum. 1, 2, 3)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4777039',
      // Linear Algebra / Determinants and Projection matrices
      "LA Quiz 5 (Det & Proj)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4752464',
      // Linear Algebra / Eigen Vector and Eigen Values
      "LA Quiz 6 (Eigen)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4775561',
      // Linear Algebra / Module 4,5 and 6 Cumulative Quiz
      "LA Quiz 7 (Cum. 4, 5, 6)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4777041',
      // Linear Algebra / SVD and other remaining concepts
      "LA Quiz 8 (SVD + Remaining)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4787880',
      // Linear Algebra / FULL SUBJECT
      "LA Quiz 9 (FULL SUBJECT)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662775/lesson/4795386',
      // Probability / Counting
      "Prob Quiz 1 (Counting)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4148705',
      // Probability / Basic Probability
      "Prob Quiz 2 (Basic Prob)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4877068',
      // Probability / Random Variable
      "Prob Quiz 3 (Random Var)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4877100',
      // Probability / Cumulative quiz of module 1,2,3
      "Prob Quiz 4 (Cum. 1, 2, 3)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4879819',
      // Probability / Expectation, Variance, Co-Variance and Correlation
      "Prob Quiz 5 (Exp, Var, Cov)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4877105',
      // Probability / Special Random Variables and Moment Generating Function
      "Prob Quiz 6 (Special RV)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4877108',
      // Probability / Conditional Expectation and Variance
      "Prob Quiz 7 (Cond. Exp)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4877121',
      // Probability / Cumulative Quiz of Module 4,5,6,7
      "Prob Quiz 8 (Cum. 4, 5, 6, 7)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4879903',
      // Probability / FULL SUBJECT
      "Prob Quiz 9 (FULL PROB)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/662776/lesson/4897318',
      // Statistics / Sampling Distribution and Parameter Estimation
      "Stats Quiz 1 (Sampling)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/740123/lesson/5074720',
      // Statistics / Hypothesis Testing
      "Stats Quiz 2 (Hypothesis)": 'https://learn.taai.live/learn/home/GATE-2027/Python---DSA-Question-Bank/section/740123/lesson/5081484',
    },
  },
};
